import { CLEF_LANGUAGES, OTHER_LANGUAGE, clefQuestions, parseClefAnswers, type ClefVerdict } from "$lib/chat/routing/clef";
import { languageName } from "$lib/chat/routing/languages";
import { logger } from "$lib/chat/server/logger";
import type { ClefConfig } from "$lib/chat/server/clefRoutingGate";
import { replayOrRecord, type ReplayMode } from "$lib/chat/server/endpoints/openai/modelReplay";

/**
 * Clef's own budget. `clef` takes 1.2–2.7 s with this question set and a cold `clef-flash` call can
 * take close to 10 s. A read that arrives after the person
 * has sent is wasted, so give up well before that.
 */
const CLEF_TIMEOUT_MS = 4_000;
/**
 * Only the start of a long draft is sent: language, size and skills show in the first lines, and
 * each read's cost grows with its input tokens. The local read still sees all of it.
 */
export const CLEF_MAX_CHARS = 1_500;

export class ClefError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/**
 * The fetch a draft read goes through. SOL-201: in a scenario run (`mode` from resolveReplayMode) it is
 * the model replay store, so CI's reads are answered from a recording and stop spending the Clef quota
 * real visitors share. The key is the whole request: Clef's path, model, question set and draft.
 */
export function clefFetch(mode: ReplayMode | null, live: typeof fetch = fetch): typeof fetch {
	if (!mode) return live;
	return ((url: string | URL | Request, init?: RequestInit) =>
		replayOrRecord(url, init, (i) => live(url, i), { clef: true }, mode)) as typeof fetch;
}

/**
 * One Clef call: the draft read and the sent message's language read both go through here. Returns
 * Clef's `result`; throws ClefError (502 upstream failure, 504 timeout).
 */
async function clefResultFor(
	text: string,
	questions: unknown,
	cfg: ClefConfig,
	timeoutMs: number,
	fetchImpl: typeof fetch
): Promise<{ model?: string; answers?: unknown }> {
	let res: Response;
	try {
		res = await fetchImpl(`${cfg.url}/${encodeURIComponent(cfg.model)}`, {
			method: "POST",
			headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: cfg.model, state: text.slice(0, CLEF_MAX_CHARS), questions }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		const timedOut = e instanceof DOMException && e.name === "TimeoutError";
		throw new ClefError(timedOut ? "clef timed out" : `clef unreachable: ${String(e)}`, timedOut ? 504 : 502);
	}
	const body = (await res.json().catch(() => null)) as {
		success?: boolean;
		result?: { model?: string; answers?: unknown };
		errors?: { message?: string }[];
	} | null;
	if (!res.ok || !body?.success || !body.result) {
		throw new ClefError(`clef ${res.status}: ${body?.errors?.[0]?.message ?? "no result"}`, 502);
	}
	return body.result;
}

/** Ask Clef about one draft. Throws ClefError (502 upstream failure, 504 timeout). */
export async function classifyWithClef(
	text: string,
	cfg: ClefConfig,
	fetchImpl: typeof fetch = fetch
): Promise<ClefVerdict> {
	const started = Date.now();
	const result = await clefResultFor(text, clefQuestions(), cfg, CLEF_TIMEOUT_MS, fetchImpl);
	try {
		return parseClefAnswers(result.answers, result.model ?? cfg.model, Date.now() - started);
	} catch (e) {
		throw new ClefError(e instanceof Error ? e.message : "unreadable clef answer", 502);
	}
}

/**
 * A per-session allowance for drafts read, separate from the per-message limits (rateLimit.ts): a
 * draft read is not a turn and must not spend a person's message budget. The client already sends
 * at most one read at a time after a pause (remoteRead.ts); this is the ceiling for a client that
 * doesn't. In memory, per server instance, so approximate on serverless, which is enough for a
 * backstop.
 */
export const CLEF_READS_PER_MINUTE = 30;
const windows = new Map<string, number[]>();

export function takeClefRead(key: string, now = Date.now()): boolean {
	const recent = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
	if (recent.length >= CLEF_READS_PER_MINUTE) {
		windows.set(key, recent);
		return false;
	}
	recent.push(now);
	windows.set(key, recent);
	if (windows.size > 5_000) {
		for (const [k, ts] of windows) if (!ts.some((t) => now - t < 60_000)) windows.delete(k);
	}
	return true;
}

export function __resetClefReadsForTest(): void {
	windows.clear();
}

/**
 * The sent message's language, asked of Clef with `extra` languages offered beside the ones Auto asks
 * about (CUR-2237). Auto's list leaves out languages it has no benchmark row for, Hausa among them, so
 * it can't name one; offered it, Clef can, where the trigram profiles cannot reliably. Returns the
 * chosen code when its probability
 * clears `floor`, null when Clef chose something else or was unsure, and undefined when Clef could not
 * be asked. A no-read is logged as an error naming why (no config, timeout, upstream status, a replay
 * miss on a scenario run), since the turn then goes out without the language named. There is no
 * second detector behind it: the trigram profiles miss the short questions this exists for.
 */
export async function clefLanguageOf(
	text: string,
	extra: readonly string[],
	cfg: ClefConfig | undefined,
	fetchImpl: typeof fetch = fetch,
	floor = 0.6
): Promise<string | null | undefined> {
	const noRead = (reason: string) => {
		logger.error({ reason, extra }, "[clef] language read failed; the answer goes out without its language named");
		return undefined;
	};
	if (!cfg) return noRead("CLEF_BASE_URL or CLEF_API_KEY missing");
	const criteria = Object.fromEntries([
		...[...new Set([...extra, ...CLEF_LANGUAGES])].map((t) => [t, languageName(t)]),
		[OTHER_LANGUAGE, "Another language, or too little text to tell"],
	]);
	const questions = {
		language: { type: "choice", instructions: "Which language is this chat message written in?", criteria },
	};
	let result: { answers?: unknown };
	try {
		result = await clefResultFor(text, questions, cfg, CLEF_LANGUAGE_TIMEOUT_MS, fetchImpl);
	} catch (e) {
		return noRead(e instanceof Error ? e.message : String(e));
	}
	const lang = (result.answers as { language?: { choice?: unknown; probabilities?: Record<string, unknown> } } | undefined)
		?.language;
	if (typeof lang?.choice !== "string") return noRead("clef answered without a language choice");
	const p = Number(lang.probabilities?.[lang.choice]);
	return Number.isFinite(p) && p >= floor ? lang.choice : null;
}

/** The language read holds the turn's first token, so it gets less than the draft read's budget. */
const CLEF_LANGUAGE_TIMEOUT_MS = 2_000;
