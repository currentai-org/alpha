// Server-side open-web search — the in-process equivalent of the /api/search/classify + /api/search
// routes, so the chat POST handler can sequence search AFTER community/RAG (community-first retrieval).
//
// Search runs server-side, after the chat POST arrives: a client-side search would force web sources to
// be numbered [1..N] before RAG and make "web only if community is insufficient" impossible (the client
// can't see the server-side RAG result). Running it here lets the handler: run RAG first, then
// decide the web step by the user's webSearchMode + community sufficiency, and number web AFTER community.
//
// Best-effort everywhere, mirroring the client path: a failed decision searches under margin and falls
// back to the recency heuristic under model/tool; a failed/empty search degrades to an ungrounded
// answer. Never throws — the turn proceeds regardless.

import { config } from "$lib/chat/server/config";
import {
	retrieveWeb,
	numberWebSources,
	type WebSearchOutcome,
	type WebRetrieval,
	type WebProgress,
} from "./openSearch";
import { contextualizeQuery, type RewriteTurn } from "./queryRewrite";
import { classifySearchNeed, decideSearchViaTool } from "./searchDecision";
import type { AttachmentKind, DeciderImage } from "./classifierPrompt";
import { decideSearchViaIntent, searchIntentEnabled } from "./searchIntent";
import {
	resolveTriggerStrategy,
	shouldRunSearch,
	usesModelClassifier,
} from "$lib/chat/search/triggerStrategy";
import { isRecencyQueryDenoised, isExplicitLookupRequest } from "$lib/chat/search/recency";
import type { SearchIntent } from "$lib/chat/search/queryIntent";
import type { ServingLaneModel } from "$lib/chat/server/endpoints/openai/providerPin";
import { logger } from "$lib/chat/server/logger";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { resolveClassifierLane } from "$lib/chat/server/endpoints/openai/providerPin";
import { defaultModel } from "$lib/chat/server/models";
import { embeddingBaseUrl, embeddingEndpointUrl, embeddingModel } from "$lib/chat/server/rag/env";
import { assistedByEntry } from "$lib/chat/messageProvenance";
import type { AssistedBy } from "$lib/chat/types/Message";

/** The model gate that decided a turn's search, or "none" when the strategy runs no model gate (or
 *  "margin" with the embedding gate flagged off, which is logged as a fallback). */
type SearchDecider = "embedding" | "completion" | "tool" | "vision" | "none";

export type WebSearchDecision = {
	search: boolean;
	query: string;
	preShaped: boolean;
	decider: SearchDecider;
	/** Set when the decider gave no verdict. Under margin the turn then searches; under model/tool the
	 *  recency regex decides. */
	fallback?: string;
	/** The model that gave the verdict and where it ran (CUR-984). Absent when no model decided: the
	 *  strategy runs none, or the one it runs failed and a fallback decided instead. */
	assist?: AssistedBy;
};

/** The photos the vision decider sees: the newest two in the conversation, as their screening renditions
 *  (JPEG inside 1024px, the bytes the gate screened). Older photos still ride to the answer; two keep the
 *  decision call small. */
const DECIDER_IMAGE_CAP = 2;
export function deciderImages(
	media: { screen: { images: readonly { screenB64: string }[] } } | undefined
): DeciderImage[] {
	return (media?.screen.images ?? [])
		.slice(-DECIDER_IMAGE_CAP)
		.map((im) => ({ mime: "image/jpeg", b64: im.screenB64 }));
}

/** Decide whether this turn needs the open web, server-side. Mirrors decideSearch (resolveSearch.ts) +
 *  the /api/search/classify route: the model classifier is the primary decider under model/tool, with the
 *  recency heuristic OR'd in; under margin the embedding gate is the only decider and no verdict means
 *  search (CUR-2109). Returns the
 *  decision, the query to run (the model's authored query when it tool-called, else the raw text), and
 *  which decider ran plus why it fell back, if it did. */
export async function decideWebSearch(
	text: string,
	locals: App.Locals | undefined,
	// The route's ALREADY-computed recency signal (isRecencyQueryDenoised), threaded so the auto decision,
	// webSearchPlan, and #4's recency prior share ONE value instead of each recomputing it (plan MINOR-2).
	// Undefined → compute it here (unchanged for callers that don't pass it). Since the heuristic is pure,
	// a passed value is identical to a recomputed one — this just makes the single source of truth explicit.
	recency?: boolean,
	// The model SERVING this turn. Only the "tool" strategy asks it, since that decision depends on the
	// answerer's own tool calling; the "model" classifier is a side call on TASK_MODEL (CUR-2092).
	servingModel?: ServingLaneModel,
	// What came with the message (CUR-3192). Told to the deciders that read prose; the embedding gate reads
	// the typed text alone, so a turn with files goes to the completion classifier instead of it.
	attachments: readonly AttachmentKind[] = [],
	// The conversation's photos, passed only when the serving model reads images and calls tools. Then
	// that model decides from the photo itself and writes the query from what it sees, whatever the
	// strategy: the way Google's AI Mode and ChatGPT search an image (CUR-3192).
	images: readonly DeciderImage[] = []
): Promise<WebSearchDecision> {
	const strategy = resolveTriggerStrategy(
		Reflect.get(config, "PUBLIC_SEARCH_TRIGGER") as string | undefined
	);
	const heuristicHit = recency ?? isRecencyQueryDenoised(text);
	// The user's own stated ask ("look this up", "check online", "fact-check") — an independent
	// signal from heuristicHit (see recency.ts + triggerStrategy.shouldRunSearch for why the margin
	// strategy can trust this even though it deliberately ignores the topic-based recency heuristic).
	const explicitLookupHit = isExplicitLookupRequest(text);
	// Which model decider ran, and, when it produced no verdict, why. Every such turn is a fail-open
	// departure (CUR-68), counted as one rather than left to read like a real "no" (CUR-2108): under
	// margin it searches, under model/tool the recency regex decides in the decider's place.
	let decider: SearchDecider = "none";
	let fallback: string | undefined;
	let classifierHit = false;
	let modelQuery: string | undefined;
	let assist: AssistedBy | undefined;
	if (images.length > 0) {
		decider = "vision";
		try {
			const d = await decideSearchViaTool(text, locals, servingModel, attachments, images);
			classifierHit = d.shouldSearch;
			modelQuery = d.query;
			if (!d.ok) fallback = "vision-call-failed";
			else {
				const lane = resolveClassifierLane(
					servingModel ?? defaultModel,
					config.OPENAI_BASE_URL,
					config.OPENAI_PROVIDER
				);
				assist = assistedByEntry("search-decision", lane.modelId, lane.baseURL);
			}
		} catch (e) {
			logger.warn(e, "[search] vision decision threw");
			fallback = "threw";
		}
	} else if (usesModelClassifier(strategy)) {
		try {
			if (strategy === "tool") {
				decider = "tool";
				const d = await decideSearchViaTool(text, locals, servingModel, attachments);
				classifierHit = d.shouldSearch;
				modelQuery = d.query;
				if (!d.ok) fallback = "tool-call-failed";
				else {
					const lane = resolveClassifierLane(
						servingModel ?? defaultModel,
						config.OPENAI_BASE_URL,
						config.OPENAI_PROVIDER
					);
					assist = assistedByEntry("search-decision", lane.modelId, lane.baseURL);
				}
			} else if (strategy === "margin" && attachments.length === 0) {
				// "margin" is the embedding gate. There is no logprob gate: not every model returns a
				// logprobs array, so such a gate cannot decide for every lane (CUR-1297, CUR-2108).
				if (searchIntentEnabled()) {
					decider = "embedding";
					const v = await decideSearchViaIntent(text);
					classifierHit = v.shouldSearch;
					if (!v.ok) fallback = `embedding-${v.reason ?? "no-opinion"}`;
					else
						assist = assistedByEntry(
							"search-decision",
							embeddingModel(),
							embeddingEndpointUrl() || embeddingBaseUrl()
						);
				} else {
					fallback = "embedding-gate-off";
				}
			} else {
				decider = "completion";
				const v = await classifySearchNeed(text, locals, attachments);
				classifierHit = v.shouldSearch;
				if (!v.ok) fallback = "completion-failed";
				else if (v.served)
					assist = assistedByEntry(
						"search-decision",
						v.served.model,
						v.served.backend,
						v.served.provider
					);
			}
		} catch (e) {
			logger.warn(e, "[search] decision classifier threw; the strategy's fallback decides this turn");
			fallback = "threw";
		}
	}
	const classifierOk = fallback === undefined;
	if (!classifierOk) {
		classifierHit = false;
		failOpenDeparture("search-decision", fallback as string, { strategy, decider });
	}
	// A photo turn is the vision model's call alone. The recency regex reads only the typed words, and a
	// failed vision call falls back to no search rather than to a search on those words.
	// "Look this up" still searches.
	const search =
		decider === "vision"
			? explicitLookupHit || (classifierOk && classifierHit)
			: shouldRunSearch({
					heuristicHit,
					classifierHit,
					classifierOk,
					strategy,
					explicitLookupHit,
				});
	// The DECISION INPUTS, logged where they are all still in scope. `decider` names the model gate that
	// ran and `fallback` says why it gave no verdict, so a regex decision is never mistaken for a model
	// one. Booleans and fixed tokens only: the user's text never goes in a log line.
	//
	// Reason is the FIRST signal that would have carried the decision, in shouldRunSearch's own order,
	// so it can be counted directly rather than inferred from a combination.
	logger.info(
		{
			strategy,
			decider,
			fallback,
			searched: search,
			explicitLookupHit,
			heuristicHit,
			classifierHit,
			classifierOk,
			attachments: attachments.length,
			images: images.length,
			reason: !search
				? "none"
				: decider === "vision"
					? classifierHit && classifierOk
						? "classifier"
						: "explicit"
				: strategy === "margin"
					? classifierOk
						? "classifier"
						: "fallback"
					: explicitLookupHit
						? "explicit"
						: classifierHit && classifierOk
							? "classifier"
							: "heuristic",
		},
		"[search] decision"
	);
	// preShaped: the returned query is the MODEL-AUTHORED tool query (not the raw user text), so openSearch
	// should NOT re-distill it — it flows into the engines verbatim (#5b). Only the tool strategy authors a
	// query; margin/model classifiers don't, so those return the raw text with preShaped=false.
	const preShaped = classifierHit && !!modelQuery;
	return {
		search,
		query: preShaped ? (modelQuery as string) : text,
		preShaped,
		decider,
		fallback,
		...(assist ? { assist } : {}),
	};
}

/** Coreference-rewriting + turn-quality options shared by the numbered (runWebSearch) and deferred
 *  (runWebRetrieval) chat-turn search paths. */
export type RunWebOpts = {
	locals: App.Locals | undefined;
	history?: RewriteTurn[];
	/** Turn-quality context (#1/#4): the route's stored recency signal + raw-text intent signals.
	 *  openSearch classifies the finalized query itself and UNIONS these raw signals for engine rescue,
	 *  and uses `recency` for the (flag-gated) recency prior. */
	ctx?: { recency: boolean; latest?: boolean; rawSignals?: Set<SearchIntent> };
	/** The query is already model-authored (tool strategy) — pass through so openSearch skips distill (#5b). */
	preShaped?: boolean;
	/** Told why a leg that ran produced no outcome, so the turn can say its search failed rather (CUR-4091)
	 *  than read as one nobody ran. Not called for the query guard (nothing ran) or for an empty outcome. */
	onFailed?: (why: WebSearchFailure) => void;
	/** The `web_search_hangs` fault (faultInjection.ts, preview only): the leg never settles, so only the
	 *  deadline ends it. */
	hang?: boolean;
};

/** Why a web leg that ran produced no outcome: it passed its deadline, or it threw. */
export type WebSearchFailure = "timeout" | "error";

/** The whole web leg's ceiling, rewrite through enrichment (CUR-4089). Each stage inside has its own
 *  bound, yet a leg can still hang past all of them, and a hung leg would hold the turn until the 45s
 *  generation watchdog ended it with no answer and no turn plan. The slowest completed web leg takes
 *  about 7.5s (Axiom `[retrieval] timing`), so 15s cuts only a leg that has hung. */
const WEB_RETRIEVAL_DEADLINE_MS = 15_000;

/** Run the open-web RETRIEVAL server-side WITHOUT assigning citation numbers (TTFT plan §5.1). The chat
 *  route uses this to run web retrieval CONCURRENTLY with RAG in "always" mode, then numbers the hits
 *  community-first at the join (numberWebSources) once the community count is known — instead of
 *  serialising the whole web round-trip after RAG just to learn the offset. `history` enables coreference
 *  rewriting of a follow-up ("…about it") before searching.
 *
 *  Returns the outcome even when `merged` is EMPTY (a completed round-trip that verified nothing above the
 *  floor is "searched, nothing grounded" — Message.searchAttempt.searched=true — NOT "no search ran"; the
 *  caller gates grounding on sources.length so an empty outcome never grounds). `undefined` is reserved
 *  for "didn't run" (the query guard), a thrown error, or a leg still running at `deadlineMs`. */
export async function runWebRetrieval(
	query: string,
	opts: RunWebOpts,
	deadlineMs: number = WEB_RETRIEVAL_DEADLINE_MS
): Promise<WebRetrieval | undefined> {
	const raw = query.trim();
	if (!raw || raw.length > 400) return undefined;
	const startedAt = Date.now();
	// Where the leg was when the deadline fired: no line inside the leg says, since every stage logs
	// only when it fails or ends (CUR-4089).
	const progress: WebProgress = { stage: "rewrite", pending: new Set() };
	// One reason per leg: a leg cut at the deadline that throws later must not rename its failure.
	let reported = false;
	const report = (why: WebSearchFailure) => {
		if (reported) return;
		reported = true;
		opts.onFailed?.(why);
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			logger.warn(
				{
					deadlineMs,
					ms: Date.now() - startedAt,
					stage: progress.stage,
					pendingEngines: [...progress.pending].sort(),
				},
				"[search] web retrieval passed its deadline; answering ungrounded"
			);
			report("timeout");
			resolve(undefined);
		}, deadlineMs);
	});
	try {
		const leg = opts.hang
			? new Promise<undefined>(() => {})
			: retrieveOnce(raw, { ...opts, onFailed: report }, progress);
		return await Promise.race([leg, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function retrieveOnce(
	raw: string,
	opts: RunWebOpts,
	progress: WebProgress
): Promise<WebRetrieval | undefined> {
	try {
		const rewriteStart = Date.now();
		let rewriteAssist: AssistedBy | undefined;
		const q = opts.history?.length
			? await contextualizeQuery(raw, opts.history, opts.locals, (s) => {
					rewriteAssist = assistedByEntry("query-rewrite", s.model ?? s.requestedModel, s.backend, s.provider);
				})
			: raw;
		const rewriteMs = Date.now() - rewriteStart;
		// This is the CHAT turn's web search — on the TTFT hot path — so opt into a per-engine cap (3500ms)
		// below the 4500ms overall backstop: one slow/hung open-web engine (usually export.arxiv) can't hold
		// the whole fan-out to the full cap. Healthy engines answer in <800ms, so this only bites a
		// genuinely-stalled source (which the rerank would likely drop anyway); fail-open, quality-neutral in
		// practice. Firecrawl is EXEMPT from this cap (CUR-633) — retrieveWeb gives it its own longer,
		// independent budget (DEFAULT_FIRECRAWL_TIMEOUT_MS in openSearch.ts) since it's a live web crawl,
		// not a fast static-index lookup, and this 3500ms would cut it off on most turns.
		// recency + rawSignals feed intent routing / the recency prior; preShaped skips distill (#1/#4/#5b).
		const r = await retrieveWeb(q, {
			perEngineTimeoutMs: 3500,
			recency: opts.ctx?.recency ?? false,
			latest: opts.ctx?.latest ?? false,
			rawSignals: opts.ctx?.rawSignals,
			preShaped: opts.preShaped ?? false,
			locals: opts.locals,
			progress,
		});
		// Verified-empty telemetry: the reranker VETTED the candidates and found none above the relevance
		// floor. That's an honest "nothing relevant" (→ the turn answers ungrounded), NOT a failure — log
		// it before we drop the zero-source outcome, so the retrieval trace can tell it apart from "no
		// search ran". Grounding still requires sources, so this stays a no-op for the grounded predicate.
		if (r.relevanceVerified && r.merged.length === 0) {
			// Length only, never the query text -- same "Booleans only" rule this file
			// states above. (CUR-918)
			logger.info(
				{ queryLength: q.length },
				"[search] verified-empty: reranker found no source above the floor"
			);
		}
		// Return the outcome even when empty — a completed round-trip that grounded nothing must still record
		// searched=true (see the JSDoc); undefined is "didn't run". The caller's sources.length gate keeps an
		// empty outcome from ever grounding the turn.
		const withAssist = rewriteAssist ? { ...r, rewriteAssist } : r;
		return r.timings ? { ...withAssist, timings: { ...r.timings, rewriteMs } } : withAssist;
	} catch (e) {
		logger.warn(e, "[search] open-web search failed; answering ungrounded");
		opts.onFailed?.("error");
		return undefined;
	}
}

/** Run the open-web search server-side with citation numbers assigned immediately. `startAt` offsets the
 *  numbers so web sources continue after the community/RAG sources already numbered for this turn
 *  ([k+1..]) — used on the AUTO path, where the community count is known before the (community-dependent)
 *  gate decides to search. Undefined only when the search DIDN'T run (query guard / error); a ran-but-empty
 *  search returns a 0-source outcome (searched=true, grounds nothing). Thin wrapper over runWebRetrieval +
 *  numberWebSources so the two paths share one retrieval + numbering authority. */
export async function runWebSearch(
	query: string,
	opts: RunWebOpts & { startAt?: number }
): Promise<WebSearchOutcome | undefined> {
	const r = await runWebRetrieval(query, opts);
	if (!r) return undefined;
	const { sources, evidence } = numberWebSources(r.merged, opts.startAt ?? 0, r.credibility);
	return {
		query: r.query,
		sources,
		evidence,
		asOf: r.asOf,
		relevanceVerified: r.relevanceVerified,
		timings: r.timings,
		...(r.rewriteAssist ? { rewriteAssist: r.rewriteAssist } : {}),
	};
}
