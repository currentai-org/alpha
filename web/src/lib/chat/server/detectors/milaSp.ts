// detectors/milaSp — the Mila suicide-prevention classifier for the chat turn's finished answer (flag
// `mila-sp-output-guard`). The route calls milaSpScore once a turn's answer has streamed in full; a hit shows
// the crisis card under that answer and ends the conversation. The answer itself is never held or changed.
//
// The model scores the assistant response alone, 512 tokens at most with its two special tokens, so a longer
// answer is cut into windows by the endpoint's own tokenizer:
//   • `POST /tokenize` (no special tokens) gives each token's UTF-8 BYTE offsets;
//   • consecutive, non-overlapping windows of at most 510 tokens, each sliced out of the answer's bytes from
//     its first token's start to its last token's stop, so every token is in exactly one window;
//   • `POST /predict` with `inputs: [[w1], [w2], …]` (one input per window; a flat list is read as ONE
//     sentence pair) and `raw_scores: true`, 32 windows per call, further calls in parallel.
// p(unsafe) is the sigmoid of each window's raw logit, and the answer's score is the highest p.
//
// It fails OPEN. Any check it cannot finish — the key or the endpoint unset, a non-2xx, a network error, a bad body, a result
// count that is not the window count, or no answer within one budget for the whole check — is `unknown`, and
// `unknown` never flags. Nothing here logs; the caller logs the verdict, never the text.
import { MILA_SP_GUARD } from "../../../../../config/safetyScreen";
import { judgeApiBase } from "./judgeApiBase";

/** Tokens per window: 512 with the `<bos>` and `<eos>` that `/predict` adds. */
export const MILA_SP_WINDOW_TOKENS = 510;
/** The endpoint's `max_client_batch_size`. */
export const MILA_SP_MAX_BATCH = 32;

type MilaSpUnknownReason = "config" | "http" | "timeout" | "network" | "parse" | "count";

export type MilaSpResult =
	| { verdict: "unsafe" | "safe"; score: number }
	| { verdict: "unknown"; reason: MilaSpUnknownReason };

export type MilaSpOverrides = {
	fetchImpl?: typeof fetch;
	apiBase?: string;
	key?: string;
	timeoutMs?: number;
	threshold?: number;
};

/** The key, read from the env var the config names (call-time, so tests can stub). */
function milaSpKey(): string | undefined {
	return process.env[MILA_SP_GUARD.provider.api_key_env] || undefined;
}

/** The endpoint's base URL: MILA_SP_ENDPOINT_URL, or Current AI's own on its deployments. */
function milaSpApiBase(): string | undefined {
	return judgeApiBase(MILA_SP_GUARD.provider);
}

/** Both the key and an endpoint. An HF_TOKEN alone is not this classifier: a self-host holds one anyway. */
export function milaSpConfigured(): boolean {
	return Boolean(milaSpKey()) && Boolean(milaSpApiBase());
}

export function sigmoid(logit: number): number {
	return 1 / (1 + Math.exp(-logit));
}

type TokenSpan = { start: number; stop: number };

/** The windows' texts, cut from the answer's UTF-8 bytes by the tokens' byte offsets. */
export function cutWindows(text: string, tokens: TokenSpan[]): string[] {
	const bytes = new TextEncoder().encode(text);
	const decoder = new TextDecoder();
	const windows: string[] = [];
	for (let i = 0; i < tokens.length; i += MILA_SP_WINDOW_TOKENS) {
		const span = tokens.slice(i, i + MILA_SP_WINDOW_TOKENS);
		windows.push(decoder.decode(bytes.subarray(span[0].start, span[span.length - 1].stop)));
	}
	return windows;
}

class Unknown extends Error {
	constructor(readonly reason: MilaSpUnknownReason) {
		super(reason);
	}
}

function isAbort(err: unknown): boolean {
	const name = (err as { name?: unknown })?.name;
	return name === "TimeoutError" || name === "AbortError";
}

/** The token spans of the one input, or null when the body is not that shape. */
function readTokens(body: unknown, byteLength: number): TokenSpan[] | null {
	if (!Array.isArray(body) || body.length !== 1 || !Array.isArray(body[0])) return null;
	const spans: TokenSpan[] = [];
	for (const t of body[0] as unknown[]) {
		const { start, stop } = (t ?? {}) as { start?: unknown; stop?: unknown };
		if (!Number.isInteger(start) || !Number.isInteger(stop)) return null;
		const s = start as number;
		const e = stop as number;
		if (s < 0 || e < s || e > byteLength) return null;
		spans.push({ start: s, stop: e });
	}
	return spans;
}

/** One logit per input, or null when the body is not that shape. */
function readLogits(body: unknown): number[] | null {
	if (!Array.isArray(body)) return null;
	const logits: number[] = [];
	for (const r of body as unknown[]) {
		const score = Array.isArray(r) ? (r[0] as { score?: unknown } | undefined)?.score : undefined;
		if (typeof score !== "number" || !Number.isFinite(score)) return null;
		logits.push(score);
	}
	return logits;
}

/** Score a finished answer. NEVER rejects: every failure resolves to `unknown`, which never flags. */
export async function milaSpScore(text: string, signal?: AbortSignal, overrides: MilaSpOverrides = {}): Promise<MilaSpResult> {
	const key = overrides.key ?? milaSpKey();
	if (!key) return { verdict: "unknown", reason: "config" };
	const apiBase = overrides.apiBase ?? milaSpApiBase();
	if (!apiBase) return { verdict: "unknown", reason: "config" };
	const doFetch = overrides.fetchImpl ?? globalThis.fetch;
	const threshold = overrides.threshold ?? MILA_SP_GUARD.threshold;
	const budget = AbortSignal.timeout(overrides.timeoutMs ?? MILA_SP_GUARD.timeoutMs);
	const callSignal = signal ? AbortSignal.any([signal, budget]) : budget;

	const post = async (path: string, payload: unknown): Promise<unknown> => {
		let res: Response;
		try {
			res = await doFetch(`${apiBase}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify(payload),
				signal: callSignal,
			});
		} catch (err) {
			throw new Unknown(isAbort(err) ? "timeout" : "network");
		}
		if (!res.ok) throw new Unknown("http");
		try {
			return await res.json();
		} catch (err) {
			throw new Unknown(isAbort(err) ? "timeout" : "parse");
		}
	};

	try {
		const tokens = readTokens(
			await post("/tokenize", { inputs: text, add_special_tokens: false }),
			new TextEncoder().encode(text).length
		);
		if (!tokens || tokens.length === 0) return { verdict: "unknown", reason: "parse" };
		const windows = cutWindows(text, tokens);
		const batches: string[][] = [];
		for (let i = 0; i < windows.length; i += MILA_SP_MAX_BATCH) batches.push(windows.slice(i, i + MILA_SP_MAX_BATCH));
		const results = await Promise.all(
			batches.map(async (batch) => {
				const logits = readLogits(await post("/predict", { inputs: batch.map((w) => [w]), raw_scores: true }));
				if (!logits) throw new Unknown("parse");
				if (logits.length !== batch.length) throw new Unknown("count");
				return logits;
			})
		);
		const score = Math.max(...results.flat().map(sigmoid));
		return { verdict: score >= threshold ? "unsafe" : "safe", score };
	} catch (err) {
		return { verdict: "unknown", reason: err instanceof Unknown ? err.reason : "network" };
	}
}
