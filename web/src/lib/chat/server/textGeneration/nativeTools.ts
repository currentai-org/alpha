// The tools a native turn offers the model, which decides for itself when to call
// them. Retrieval runs through the same engines the scaffolded path uses (runWebSearch, the RAG stores),
// with the model writing the query, so there is no search-decision, rewrite or distill call ahead of it.
//
// Citation numbers are one namespace for the whole turn, the way the UI reads them: each search starts
// numbering after every source already returned, and each result carries the turn's full set so far.
// Searches are serialized for that reason; calculate is pure and runs alongside. (CUR-2420)

import type { NativeToolKit, NativeToolResult, StreamedToolCall } from "../endpoints/types";
import { CALCULATE_KIT, CALCULATE_COUNTS_DEFINITIONS } from "../endpoints/openai/calculateTool";
import { DATETIME_TOOL, runDatetime } from "./datetimeTool";
import { WEB_SEARCH_TOOL } from "../search/toolSearch";
import { runWebSearch, type WebSearchFailure } from "../search/runSearch";
import { asksForTheLatest } from "$lib/chat/search/recency";
import { maybeRagGrounding } from "../rag";
import { searchPastChats } from "../rag/pastChats";
import { fetchLinkedPage, numberWebSources } from "../search/openSearch";
import { linkedPageNote } from "../search/linkedUrl";
import { SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION } from "../search/webEvidence";
import { searchTodayLine } from "./searchGrounding";
import { queryLanguageMismatch, rewriteQueryNote, type LanguageRead } from "../search/queryLanguage";
import { readMessageLanguage } from "../declineCopy";
import { logger } from "../logger";
import type { Message } from "$lib/chat/types/Message";

const SEARCH_CATALOG_TOOL = {
	type: "function",
	function: {
		name: "search_catalog",
		description:
			"Search AI Potluck's catalog of open source AI projects, organizations, models and datasets, and the documents about them. Use for questions about the open AI ecosystem, a named project, or AI Potluck itself. Returns numbered sources to cite.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look up in the catalog." },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} as const;

// Offered only to a signed-in person who switched past-chat search on (pastChatSearchGate.ts).
// Its sources join the catalog's in the turn's `rag` stamp, numbered in the same namespace, and the note
// under the answer reads them from there. (CUR-4576)
const SEARCH_PAST_CHATS_TOOL = {
	type: "function",
	function: {
		name: "search_past_chats",
		description:
			"Search the person's own earlier conversations with you, by keyword. Use when they refer to something from an earlier chat or ask what they told you before. Returns numbered passages to cite.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keywords to look for in their earlier chats." },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} as const;

const NO_PAST_CHAT =
	"No earlier chat of theirs matched. Say that you found nothing about it in their earlier chats, and do not guess what they said.";

// The link the person pasted, opened the way the scaffolded path opens it (CUR-1897). No URL
// argument: linkedUrl.ts allows a fetch only of a URL the person typed in this message, never one the
// model writes, so the tool can open that one link and nothing else. (CUR-2734)
const READ_PAGE_TOOL = {
	type: "function",
	function: {
		name: "read_page",
		description:
			"Open the web page the person linked in their latest message and read its text. Returns it as a numbered source to cite.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
} as const;

type WebStamp = NonNullable<Message["webSearch"]>;

/** What a turn's tools retrieved, for checking the answer against it afterwards (groundcheck). */
export type NativeGrounding = {
	/** The evidence text of every search and page read that returned sources, in call order. */
	evidence: string[];
	sources: { n: number; title: string }[];
	/** calculate ran: its numbers are code-rendered and no source states them. */
	calculated: boolean;
};
type RagStamp = NonNullable<Message["rag"]>;

function queryOf(call: StreamedToolCall): string {
	try {
		const q = (JSON.parse(call.arguments || "{}") as { query?: unknown }).query;
		return typeof q === "string" ? q.trim() : "";
	} catch {
		return "";
	}
}

const NOTHING = "No sources found. Answer from what you know and say that nothing was found.";
// The search ran and did not finish, which is not the same as finding nothing. (CUR-4091)
const SEARCH_UNFINISHED =
	"The web search did not finish, so no web results came back. Answer from what you know and say that the search did not finish.";
// The scaffolded turn grounds a pasted-link turn on the page alone once it is read (CUR-2032,
// the route's `webSearchCtx` swap), so a search after a read adds nothing here either. (CUR-2697)
const LINKED_PAGE_ONLY =
	"The page linked in this message has been read and is this turn's source. Answer from it; no search was run.";

/**
 * Appended to every tool result that returns sources. The system prompt asks for inline [n] citations
 * too, but a probe (CUR-2420) found some models skip them on web-sourced turns; the reminder sits where the model reads the sources.
 */
function citeNote(sources: ReadonlyArray<{ n: number }>): string {
	if (!sources.length) return "";
	const first = `[${sources[0].n}]`;
	const last = `[${sources[sources.length - 1].n}]`;
	const range = first === last ? first : `${first} to ${last}`;
	return `\n\n${SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION} Cite each fact you take from these sources inline by its number (${range}), right after the sentence that uses it.`;
}

export function nativeToolKit(opts: {
	locals: App.Locals | undefined;
	/** false withholds web_search (the composer's search is off). */
	web: boolean;
	/** true forces the first round to call web_search (the composer's search is "always"). */
	forceWeb?: boolean;
	/** The question asks for a live value no source here carries (isUnservableLiveQuery), so (CUR-2697)
	 *  web_search is withheld the way the scaffolded turn skips its search. read_page is unaffected. */
	liveUnservable?: boolean;
	/** Test seam for the two retrieval engines. */
	engines?: {
		web: typeof runWebSearch;
		catalog: typeof maybeRagGrounding;
		pastChats?: typeof searchPastChats;
	};
	/** The signed-in owner whose earlier chats search_past_chats reads, and the chat this turn (CUR-4576)
	 *  is in, which it leaves out. Absent: the tool is not offered. */
	pastChats?: { userId: string; currentConversationId: string };
	/** The fetchable link in the person's latest message (extractLinkedUrl). With `web`, the first round
	 *  opens it. */
	linkedUrl?: string;
	/** Test seam for the page reader. */
	readPage?: typeof fetchLinkedPage;
	/** How many numbered sources the person pasted (visitorSources.ts); ours are numbered after them
	 *  (CUR-3844). */
	visitorSourceCount?: number;
	/** The person's message asks for the latest of something (asksForTheLatest), so its search also looks
	 *  at the past year, the way the scaffolded turn's does (CUR-3932). */
	latest?: boolean;
	/** calculate asks for each group's count before the expression (harnessProfiles `calculateCounts`,
	 *  CUR-4015). */
	calculateCounts?: boolean;
	/** The `web_search_hangs` fault (preview only): every web search hangs until its deadline. */
	hangWeb?: boolean;
	/** The person's message language (639-3), set when `search-query-language` is on: the first query
	 *  written in another non-English language is sent back for a rewrite (CUR-4376). */
	askedLanguage?: string;
	/** Test seam for reading the query's language. */
	readLanguage?: LanguageRead;
}): NativeToolKit & { grounding(): NativeGrounding } {
	const web = opts.engines?.web ?? runWebSearch;
	const readLanguage = opts.readLanguage ?? readMessageLanguage;
	// Once per turn, so a model that keeps its language still gets a search rather than a loop.
	let languageSentBack = false;
	const catalog = opts.engines?.catalog ?? maybeRagGrounding;
	const pastChatSearch = opts.engines?.pastChats ?? searchPastChats;
	const readPage = opts.readPage ?? fetchLinkedPage;
	const linkedUrl = opts.web ? opts.linkedUrl : undefined;
	const offerSearch = opts.web && !opts.liveUnservable;
	let pageRead = false;
	let numbered = opts.visitorSourceCount ?? 0;
	let webStamp: WebStamp | undefined;
	let ragStamp: RagStamp | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	const evidence: string[] = [];
	let calculated = false;

	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => undefined);
		return next;
	};

	// The scaffolded path's grounding gate (route, `groundedWeb`): results the reranker did not vet are
	// never evidence. With a reranker configured an unvetted search already comes back empty; this covers
	// a deploy with none, where every result arrives unvetted (CUR-2697).
	const vettedWeb = async (query: string) => {
		// The model's own query can drop the "latest" the person asked for, so either counts. (CUR-3932)
		const latest = !!opts.latest || asksForTheLatest(query);
		let failed: WebSearchFailure | undefined;
		const r = await web(query, {
			locals: opts.locals,
			preShaped: true,
			startAt: numbered,
			ctx: { recency: latest, latest },
			hang: opts.hangWeb,
			onFailed: (why) => (failed = why),
		});
		// The native path writes no `[retrieval] timing` line, so this line logs per-engine time
		// and failures for turns that search through this tool. `webMs` keeps that line's field names, so the
		// same Axiom queries read both. (CUR-4282)
		logger.info(
			{ webMs: r?.timings, sources: r?.sources.length ?? 0, verified: Boolean(r?.relevanceVerified), failed },
			"[native] web_search timing"
		);
		return { r: r?.relevanceVerified ? r : undefined, failed };
	};

	const searchWeb = (query: string) =>
		serial(async (): Promise<NativeToolResult> => {
			if (pageRead) return { content: LINKED_PAGE_ONLY };
			const asked = await queryLanguageMismatch(opts.askedLanguage, query, readLanguage);
			if (asked) {
				// Language tags only: the query carries the person's words.
				logger.info(
					{ asked, written: await readLanguage(query), resent: languageSentBack },
					languageSentBack
						? "[search] query still not in the person's language; searched as written"
						: "[search] query sent back for a rewrite in the person's language"
				);
				if (!languageSentBack) {
					languageSentBack = true;
					return { content: rewriteQueryNote(asked) };
				}
			}
			const { r, failed } = await vettedWeb(query);
			if (failed) return { content: SEARCH_UNFINISHED, searchFailed: failed };
			if (!r?.sources.length) return { content: NOTHING };
			numbered += r.sources.length;
			evidence.push(r.evidence);
			webStamp = {
				query: webStamp ? `${webStamp.query}; ${r.query}` : r.query,
				sources: [...(webStamp?.sources ?? []), ...r.sources],
				asOf: r.asOf,
			};
			// Asked today's date, a model can search and read it off a stale cached world-clock
			// snippet, so the date goes where the model reads the sources' dates. (CUR-4163)
			const today = `\n\n${searchTodayLine({ zone: opts.locals?.timezone })}`;
			return { content: r.evidence + citeNote(r.sources) + today, webSearch: webStamp, rag: ragStamp };
		});

	const readLinkedPage = (url: string) =>
		serial(async (): Promise<NativeToolResult> => {
			const page = await readPage(url).catch(() => undefined);
			if (!page) return { content: linkedPageNote({ kind: "unreadable" }) };
			pageRead = true;
			const { sources, evidence: pageEvidence } = numberWebSources([page], numbered);
			numbered += sources.length;
			evidence.push(pageEvidence);
			webStamp = {
				query: webStamp ? `${webStamp.query}; ${page.url}` : page.url,
				sources: [...(webStamp?.sources ?? []), ...sources],
				asOf: webStamp?.asOf ?? new Date().toISOString(),
			};
			return {
				content: `${pageEvidence}\n\n${linkedPageNote({ kind: "read", n: sources[0].n })}`,
				webSearch: webStamp,
				rag: ragStamp,
			};
		});

	const searchCatalog = (query: string) =>
		serial(async (): Promise<NativeToolResult> => {
			const r = await catalog(query, opts.locals, numbered);
			if (!r || (!r.sources.length && !r.vaultSynthesis?.trim())) return { content: NOTHING };
			numbered += r.sources.length;
			evidence.push(r.evidence || r.vaultSynthesis || "");
			ragStamp = {
				query: ragStamp ? `${ragStamp.query}; ${r.query}` : r.query,
				sources: [...(ragStamp?.sources ?? []), ...r.sources],
				asOf: r.asOf,
				...(r.vaultSynthesis ? { vaultSynthesis: r.vaultSynthesis } : {}),
			};
			return {
				content: (r.evidence || r.vaultSynthesis || NOTHING) + citeNote(r.sources),
				webSearch: webStamp,
				rag: ragStamp,
			};
		});

	const searchPast = (query: string) =>
		serial(async (): Promise<NativeToolResult> => {
			if (!opts.pastChats) return { content: NO_PAST_CHAT };
			const started = Date.now();
			const r = await pastChatSearch(query, opts.pastChats, numbered).catch((error: unknown) => {
				logger.warn({ err: String(error) }, "[native] search_past_chats failed");
				return null;
			});
			// Counts and time only: the query and the passages are the person's own words.
			logger.info({ ms: Date.now() - started, sources: r?.sources.length ?? 0 }, "[native] search_past_chats timing");
			if (!r?.sources.length) return { content: NO_PAST_CHAT };
			numbered += r.sources.length;
			evidence.push(r.evidence);
			ragStamp = {
				query: ragStamp ? `${ragStamp.query}; ${r.query}` : r.query,
				sources: [...(ragStamp?.sources ?? []), ...r.sources],
				asOf: r.asOf,
				...(ragStamp?.vaultSynthesis ? { vaultSynthesis: ragStamp.vaultSynthesis } : {}),
			};
			return {
				content: `These passages come from the person's own earlier chats. Each says who wrote it then; what Alpha answered then may have been wrong.\n\n${r.evidence}${citeNote(r.sources)}`,
				webSearch: webStamp,
				rag: ragStamp,
			};
		});

	const definitions: NativeToolKit["definitions"] = [
		...(offerSearch ? [WEB_SEARCH_TOOL as unknown as NativeToolKit["definitions"][number]] : []),
		...(linkedUrl ? [READ_PAGE_TOOL as unknown as NativeToolKit["definitions"][number]] : []),
		SEARCH_CATALOG_TOOL as unknown as NativeToolKit["definitions"][number],
		...(opts.pastChats ? [SEARCH_PAST_CHATS_TOOL as unknown as NativeToolKit["definitions"][number]] : []),
		...(opts.calculateCounts ? CALCULATE_COUNTS_DEFINITIONS : CALCULATE_KIT.definitions),
		DATETIME_TOOL as unknown as NativeToolKit["definitions"][number],
	];

	return {
		label: "native",
		definitions,
		grounding: () => ({
			evidence: evidence.filter(Boolean),
			sources: [...(webStamp?.sources ?? []), ...(ragStamp?.sources ?? [])],
			calculated,
		}),
		// A pasted link is what the person asked about, so it is read first, ahead of a forced search.
		firstRoundTool: linkedUrl
			? READ_PAGE_TOOL.function.name
			: offerSearch && opts.forceWeb
				? WEB_SEARCH_TOOL.function.name
				: undefined,
		retrievalOf: (calls) => {
			const names = new Set(calls.map((c) => c.name));
			const webCall =
				opts.web &&
				((offerSearch && names.has(WEB_SEARCH_TOOL.function.name)) ||
					(!!linkedUrl && names.has(READ_PAGE_TOOL.function.name)));
			const documents =
				names.has(SEARCH_CATALOG_TOOL.function.name) ||
				(!!opts.pastChats && names.has(SEARCH_PAST_CHATS_TOOL.function.name));
			if (webCall && documents) return "documents-web";
			if (webCall) return "web";
			if (documents) return "documents";
			return undefined;
		},
		run: async (call) => {
			if (call.name === WEB_SEARCH_TOOL.function.name && offerSearch) {
				const q = queryOf(call);
				return q ? searchWeb(q) : { content: "web_search needs a non-empty query." };
			}
			if (call.name === READ_PAGE_TOOL.function.name && linkedUrl) return readLinkedPage(linkedUrl);
			if (call.name === SEARCH_CATALOG_TOOL.function.name) {
				const q = queryOf(call);
				return q ? searchCatalog(q) : { content: "search_catalog needs a non-empty query." };
			}
			if (call.name === SEARCH_PAST_CHATS_TOOL.function.name && opts.pastChats) {
				const q = queryOf(call);
				return q ? searchPast(q) : { content: "search_past_chats needs a non-empty query." };
			}
			if (call.name === CALCULATE_KIT.definitions[0].function.name) {
				calculated = true;
				return CALCULATE_KIT.run(call);
			}
			if (call.name === DATETIME_TOOL.function.name) return runDatetime(call, opts.locals?.timezone);
			return { content: `There is no tool named ${call.name}.` };
		},
	};
}
