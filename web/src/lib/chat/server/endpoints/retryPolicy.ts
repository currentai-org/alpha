// When a failed model request is worth sending again, and how long to wait first (CUR-2432). One place
// for the rules, so the layers that retry do not disagree about them or keep separate budgets.
//
// The rules follow the OpenAI SDK's own retry logic (openai/client.js shouldRetry and
// calculateDefaultRetryTimeoutMillis), which this app switches off (OPENAI_MAX_RETRIES is unset) because
// the SDK cannot see a turn's deadline:
//   - retry 408, 409, 429, 5xx and connection failures; never a cancelled request or another 4xx;
//   - wait what the host asked for, from `retry-after-ms`, then `retry-after` in seconds or as a date;
//   - otherwise back off with full jitter (AWS, "Exponential Backoff And Jitter"), via utils/backoff.ts.
// The one rule added here: a wait is taken only when the retry can still answer inside the turn's
// deadline. A wait that cannot fit gives up at once, so the reader sees the busy notice now rather
// than after a pause that was always going to end the same way.

import { jitteredDelay } from "$lib/chat/utils/backoff";

type Failed = { status?: unknown; statusCode?: unknown; name?: unknown; headers?: unknown };

export function statusOf(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const { status, statusCode } = err as Failed;
	if (typeof status === "number") return status;
	if (typeof statusCode === "number") return statusCode;
	return undefined;
}

/** An upstream 429: the SDK's RateLimitError, or anything else carrying that status. */
export function isRateLimited(err: unknown): boolean {
	return statusOf(err) === 429;
}

/** An upstream gateway timeout (504): the host gave up waiting on the model, so the model did not answer (CUR-4345). */
export function isUpstreamTimeout(err: unknown): boolean {
	return statusOf(err) === 504;
}

/**
 * An upstream answer that says the model is not being served at all right now: a 404 (the router has no
 * working entry for it, CUR-4629) or any 5xx. Unlike a 400, our request was not the problem, so a model
 * failing this way counts toward its busy mark and Auto routes around it (modelBusy.ts).
 */
export function isHardUpstreamFailure(err: unknown): boolean {
	const status = statusOf(err);
	return status === 404 || (status !== undefined && status >= 500 && status <= 599);
}

/** A cancelled request: the turn was stopped or a watchdog fired, so nothing should resend it. */
function isAbort(err: unknown): boolean {
	const name = typeof err === "object" && err !== null ? (err as Failed).name : undefined;
	return name === "AbortError" || name === "APIUserAbortError";
}

/** Whether the same request could succeed if sent again, by the SDK's rules. */
function isRetryable(err: unknown): boolean {
	if (isAbort(err)) return false;
	const status = statusOf(err);
	if (status === undefined) {
		const name = typeof err === "object" && err !== null ? (err as Failed).name : undefined;
		return name === "APIConnectionError" || name === "APIConnectionTimeoutError";
	}
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function header(err: unknown, key: string): string | null {
	const headers = typeof err === "object" && err !== null ? (err as Failed).headers : undefined;
	if (!headers || typeof headers !== "object") return null;
	if (typeof (headers as Headers).get === "function") return (headers as Headers).get(key);
	const value = (headers as Record<string, unknown>)[key];
	return typeof value === "string" ? value : null;
}

/** The wait the host asked for, in ms, or undefined when it named none (or named a nonsense one). */
function retryAfterMs(err: unknown, now: number = Date.now()): number | undefined {
	const ms = Number.parseFloat(header(err, "retry-after-ms") ?? "");
	if (Number.isFinite(ms) && ms >= 0) return ms;
	const raw = header(err, "retry-after");
	if (!raw) return undefined;
	const seconds = Number.parseFloat(raw);
	if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** What an upstream 429 said, for the log line that records it (SOL-200): the wait the host asked for
 *  and the body the SDK kept, cut to UPSTREAM_BODY_MAX characters. Without the body nobody can tell a
 *  provider's account limit from a gateway's per-key one. */
const UPSTREAM_BODY_MAX = 500;

export function rateLimitDetail(err: unknown): { retryAfterMs?: number; upstream?: string } {
	const detail: { retryAfterMs?: number; upstream?: string } = {};
	const wait = retryAfterMs(err);
	if (wait !== undefined) detail.retryAfterMs = wait;
	const body = typeof err === "object" && err !== null ? (err as { error?: unknown }).error : undefined;
	let text: string | undefined;
	if (typeof body === "string") text = body;
	else if (body !== undefined && body !== null) {
		try {
			text = JSON.stringify(body);
		} catch {
			text = undefined;
		}
	}
	if (!text && err instanceof Error && err.message) text = err.message;
	if (text) detail.upstream = text.slice(0, UPSTREAM_BODY_MAX);
	return detail;
}

export type RetryPolicy = {
	/** Total tries, the first included. */
	maxAttempts: number;
	/** Full-jitter base and ceiling for a wait the host did not name. */
	baseMs: number;
	maxMs: number;
	/** Time an answer still needs after the wait; a retry that leaves less is not taken. */
	reserveMs: number;
};

/**
 * A tool round's policy. A per-minute cap (Mistral's key allows 30 a minute, CUR-2307) does not clear
 * in the 100–300ms the lane retry waits, so the first wait is up to a second and the second up to two.
 * Full jitter can pick a short wait; that is the trade for not sending every waiting turn back at once.
 */
export const TOOL_ROUND_RETRY: RetryPolicy = { maxAttempts: 3, baseMs: 1_000, maxMs: 8_000, reserveMs: 10_000 };

type RetryDecision =
	| { retry: true; delayMs: number; hostAsked: boolean }
	| { retry: false; reason: "not-retryable" | "attempts-spent" | "past-deadline" };

/** Whether to send again after `attempt` (0-based) failed with `err`, and after how long. */
function decideRetry(
	err: unknown,
	attempt: number,
	opts: { policy: RetryPolicy; deadlineAt?: number; now?: number; random?: () => number }
): RetryDecision {
	const { policy } = opts;
	if (!isRetryable(err)) return { retry: false, reason: "not-retryable" };
	if (attempt + 1 >= policy.maxAttempts) return { retry: false, reason: "attempts-spent" };
	const now = opts.now ?? Date.now();
	const asked = retryAfterMs(err, now);
	const delayMs =
		asked ?? jitteredDelay(attempt, { baseMs: policy.baseMs, maxMs: policy.maxMs, random: opts.random });
	if (opts.deadlineAt !== undefined && now + delayMs + policy.reserveMs > opts.deadlineAt)
		return { retry: false, reason: "past-deadline" };
	return { retry: true, delayMs, hostAsked: asked !== undefined };
}

/** A sleep that ends early, rejecting, when the turn is cancelled. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run `send`, sending again under `policy` while the failure is retryable and a retry fits the deadline.
 * Only for a request with nothing yielded yet: `send` must fail before any output reaches the reader,
 * which holds for a streamed request whose `create()` rejects on the response status.
 */
export async function withRetry<T>(
	send: (attempt: number) => Promise<T>,
	opts: {
		policy: RetryPolicy;
		deadlineAt?: number;
		signal?: AbortSignal;
		now?: () => number;
		random?: () => number;
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
		onRetry?: (info: { attempt: number; delayMs: number; hostAsked: boolean; status?: number }) => void;
	}
): Promise<T> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? sleepUnlessAborted;
	for (let attempt = 0; ; attempt++) {
		try {
			return await send(attempt);
		} catch (err) {
			const decision = decideRetry(err, attempt, {
				policy: opts.policy,
				deadlineAt: opts.deadlineAt,
				now: now(),
				random: opts.random,
			});
			if (!decision.retry) throw err;
			opts.onRetry?.({
				attempt,
				delayMs: decision.delayMs,
				hostAsked: decision.hostAsked,
				status: statusOf(err),
			});
			await sleep(decision.delayMs, opts.signal);
		}
	}
}

/** gRPC A6's `retryThrottling`, same shape and same defaults: a failed attempt costs a token, a
 *  successful one returns `tokenRatio`, and below half the bucket we stop hedging. Without this a
 *  gateway-wide failure doubles the request rate against a gateway that is already failing — A6 is
 *  explicit that "throttling also applies to hedged RPCs" for exactly that reason.
 *
 *  Under throttle we fall back to waiting on a single attempt with no hedge, hang
 *  included. That is the intended trade: during a broad failure the turn-level
 *  watchdog is a better backstop than amplifying load. */
export type HedgeThrottle = {
	allows: () => boolean;
	record: (ok: boolean) => void;
};

export function createHedgeThrottle(maxTokens = 10, tokenRatio = 0.1): HedgeThrottle {
	let tokens = maxTokens;
	return {
		allows: () => tokens > maxTokens / 2,
		record: (ok: boolean) => {
			tokens = ok ? Math.min(maxTokens, tokens + tokenRatio) : Math.max(0, tokens - 1);
		},
	};
}
