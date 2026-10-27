// Multilingual support signal (CUR-4093). The guard's distress rules are English yes/no questions put
// to Shieldstral-1.0-3B, and they do not carry over to other languages: the hedged rule scores an
// English "I feel hopeless" near 1 and the same sentence in Swahili or Hausa near 0. Every rule asks
// about "themselves", so a message about a friend who wants to die scores low.
//
// So one forced tool call on TASK_MODEL reads the user's latest message in whatever language it is
// written and answers whether the Support resources card should show. The call starts beside the input
// screen and never delays the answer. A yes stamps `moderation.support` exactly as a distress log hit
// does, and records the message's language for the card. The call can only ever add the card. An error,
// a timeout or a malformed answer leaves the turn as the guard left it.
//
// The card is additive, so a false positive costs a support note beside an ordinary answer. A false
// negative costs a person in distress the card. The prompt leans that way.
//
// With this prompt and tool the Spanish, French, Hausa and Swahili messages, German and English
// hopelessness, and English "can't do it anymore" answer show true, with the right `who`. Controls
// answer false: a French Python bug, a novel, a game, suicide statistics, divorce advice, a Swahili
// week plan, homework and a tired weekend.
//
// Behind `support-signal-classifier`; enabling it in production is a separate decision (CUR-4096).
// The message text goes to TASK_MODEL, the processor the titler already sends every first message to.

import type OpenAI from "openai";
import { forcedTaskModelToolCall } from "$lib/chat/server/taskModelClient";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import { crisisLocale } from "$lib/chat/crisisLocale";

export const SUPPORT_SIGNAL_FLAG = "support-signal-classifier";
export const supportSignalEnabled = (): boolean => flagEnabledOr(SUPPORT_SIGNAL_FLAG, () => false);

const SIGNAL_TIMEOUT_MS = 4_000;
// The tail of a long message, where distress written after a pasted document usually sits.
export const SIGNAL_MAX_CHARS = 4_000;

// The identical prefix of every call is this system message plus SUPPORT_TOOL. The gateway's Mistral lane
// takes no cache_control marker; the prefix is kept byte-stable so a provider-side prefix cache can hit.
const SUPPORT_SYSTEM =
	"You decide whether a chat app should show a support note pointing to crisis helplines beside its answer. " +
	"The note is additive: the answer is never blocked. Read the message in whatever language it is written.\n" +
	"Say yes when the writer:\n" +
	"- says or implies they want to die, to not exist, or to hurt themselves, or that others would be better off without them;\n" +
	"- says they feel hopeless, cannot cope or go on, or see no point in living or carrying on;\n" +
	"- says someone they know has expressed any of the above, or that they fear for someone's life.\n" +
	"Say no for fiction, games, research or statistics, ordinary tiredness or frustration with a task, and " +
	"general advice about someone's ordinary difficulties.";

export const SUPPORT_TOOL_NAME = "support_note";
const SUPPORT_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: SUPPORT_TOOL_NAME,
		description: "Record whether to show the crisis support note beside the answer.",
		parameters: {
			type: "object",
			properties: {
				show: { type: "boolean", description: "true to show the support note" },
				who: {
					type: "string",
					enum: ["writer", "someone_else", "none"],
					description: "whose wellbeing the message is about; none when show is false",
				},
				lang: {
					type: "string",
					description: "the message's language as a BCP-47 primary subtag, e.g. en, fr, es, sw, ha",
				},
				place: {
					type: "string",
					description:
						"an exact substring of the message, in the message's own language, that shows where the person at " +
						"risk is: a country, a city, or a service or agency that exists in only one country (for " +
						"\"trabalho no Centro de Emprego\", write \"Centro de Emprego\", not \"Portugal\"). Empty when no " +
						"words in the message show a place; the language it is written in is not a place",
				},
				country: {
					type: "string",
					description:
						"the country `place` is in, as a lower-case ISO 3166-1 alpha-2 code (fr, pt, br); empty when " +
						"`place` is empty",
				},
			},
			required: ["show", "who", "lang", "place", "country"],
			additionalProperties: false,
		},
	},
};

/** `country` is the country the message places the person at risk in, a code findahelpline has a page
 *  for, or "" (CUR-4488). The card and the helpline number guard prefer it to the visitor's IP country:
 *  a teacher in Lyon writing from Hong Kong needs France's lines, not Taiwan's. */
export type SupportSignal = { show: boolean; who: "writer" | "someone_else" | "none"; lang: string; country: string };

/** The classifier's answer for one message, or null for every way the call can fail. */
export type SupportCall = (text: string, signal: AbortSignal) => Promise<SupportSignal | null>;

type MinimalLogger = { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };

/**
 * Asks whether `text` should carry the support card. Never rejects: null when the text is empty or the
 * call fails. Logs one line with the outcome, timing, `who` and language, never the message.
 */
export async function supportSignal(
	text: string,
	deps: { call?: SupportCall; logger?: MinimalLogger; now?: () => number } = {}
): Promise<SupportSignal | null> {
	const t = text.trim();
	if (!t) return null;
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => Date.now());
	const started = now();
	const call = deps.call ?? taskModelSupportCall;
	const result = await call(t.slice(-SIGNAL_MAX_CHARS), AbortSignal.timeout(SIGNAL_TIMEOUT_MS)).catch(() => null);
	// A failure costs a person in distress the card whenever the guard's English rules also missed, so it
	// logs at warn, where a rate monitor can see it.
	log[result === null ? "warn" : "info"](
		{
			outcome: result === null ? "failed" : result.show ? "show" : "clear",
			ms: Math.round(now() - started),
			chars: t.length,
			who: result?.who ?? null,
			lang: result?.lang ?? null,
			country: result?.country || null,
		},
		"[support-signal] input"
	);
	return result;
}

/** The default call: one forced tool call on TASK_MODEL's own registered lane. */
const taskModelSupportCall: SupportCall = async (text, signal) => {
	const call = await forcedTaskModelToolCall({
		system: SUPPORT_SYSTEM,
		user: text,
		tool: SUPPORT_TOOL,
		maxTokens: 120,
		timeoutMs: SIGNAL_TIMEOUT_MS,
		signal,
	});
	return call === null ? null : parseSupportArgs(call, text);
};

const WHO = new Set(["writer", "someone_else", "none"]);
// The shape of a BCP-47 primary subtag. `lang` is model text stored on the message and used to pick the
// card's catalog, so anything else is dropped rather than stored.
const PRIMARY_SUBTAG = /^[a-z]{2,3}$/;

/** The signal from the tool call, or null when the tool is the wrong one or `show` is not a boolean. A
 *  missing or odd `who`/`lang`/`country` degrades to "none"/""/"" rather than dropping a show:true. A
 *  country findahelpline has no page for degrades to "" too, so the card falls back to the IP country.
 *  So does a country whose `place` is not in `text`: told to leave a message with no place empty, the task
 *  model can name France for "Je ne veux plus vivre. 1792859723943", so the
 *  country stands only on words the person actually wrote. */
export function parseSupportArgs(toolCall: unknown, text: string): SupportSignal | null {
	const fn = (toolCall as { function?: { name?: string; arguments?: string } } | undefined)?.function;
	if (fn?.name !== SUPPORT_TOOL_NAME || typeof fn.arguments !== "string") return null;
	try {
		const a = JSON.parse(fn.arguments) as Record<string, unknown>;
		if (typeof a.show !== "boolean") return null;
		const who = typeof a.who === "string" && WHO.has(a.who) ? (a.who as SupportSignal["who"]) : "none";
		const subtag = typeof a.lang === "string" ? a.lang.trim().toLowerCase().split(/[-_]/)[0] : "";
		const lang = PRIMARY_SUBTAG.test(subtag) ? subtag : "";
		const place = typeof a.place === "string" ? a.place.trim().toLocaleLowerCase() : "";
		const written = place.length > 1 && text.toLocaleLowerCase().includes(place);
		const country = written && typeof a.country === "string" ? (crisisLocale(a.country)?.code ?? "") : "";
		return { show: a.show, who, lang, country };
	} catch {
		return null;
	}
}

/** The part of a message's moderation record the support card reads. */
export type SupportRecord = { support?: boolean; supportLang?: string; supportCountry?: string };

/** What a SupportNotice carries to the client when the signal named something for the card. */
export type SupportNoticeExtras = { supportLang?: string; supportCountry?: string };

/**
 * Stamps the card from the signal when the guard has not already, records the message's language on a
 * card either of them stamped, and resolves whether the turn carries support once both are known. The
 * guard's English rules stamp without a language, so a French message under an English interface would
 * otherwise get the English card. `emit` sends the SupportNotice to the client. Never rejects: a failed
 * emit still leaves the stamp, so the final persist keeps the card. The turn's final persist awaits this,
 * and so do the readers that must not miss a late stamp or its language (the helpline number guard, the
 * titler).
 */
export async function stampSupportFromSignal(
	record: SupportRecord,
	signal: Promise<SupportSignal | null>,
	emit: (extras: SupportNoticeExtras) => Promise<void>
): Promise<boolean> {
	const sig = await signal.catch(() => null);
	const stamped = Boolean(record.support);
	if (!stamped && !sig?.show) return false;
	const extras = supportNoticeExtras(record, sig);
	if (stamped && !extras.supportLang && !extras.supportCountry) return true;
	record.support = true;
	Object.assign(record, extras);
	await emit(extras).catch(() => {});
	return true;
}

/** The language and country the signal names that the record does not hold yet. */
function supportNoticeExtras(record: SupportRecord, sig: SupportSignal | null | undefined): SupportNoticeExtras {
	return {
		...(sig?.lang && !record.supportLang ? { supportLang: sig.lang } : {}),
		...(sig?.country && !record.supportCountry ? { supportCountry: sig.country } : {}),
	};
}
