// Full-jitter exponential backoff (AWS "Exponential Backoff And Jitter"). Shared by the
// stop-request retry and the connect retry so that on a flaky shared network — where
// thousands of clients can recover from a micro-drop at the same instant — reconnect
// attempts spread out instead of thundering-herd in lockstep. Pure + DOM-free so it's
// unit-testable and reusable on both the stream path (agent-service seam) and the
// connectivity/UX layer.

export interface BackoffOptions {
	/** Base delay in ms; the first retry is uniform in [0, baseMs]. Default 300. */
	baseMs?: number;
	/** Hard ceiling per delay in ms (the exponential is clamped to this). Default 8000. */
	maxMs?: number;
	/** Injectable RNG for deterministic tests; defaults to Math.random. */
	random?: () => number;
}

/**
 * Full-jitter delay for a 0-based attempt: a uniform random value in
 * `[0, min(maxMs, baseMs * 2^attempt)]`. Full jitter (vs equal/decorrelated) is the
 * simplest variant with the best herd-avoidance for many independent clients.
 */
export function jitteredDelay(attempt: number, opts: BackoffOptions = {}): number {
	const { baseMs = 300, maxMs = 8000, random = Math.random } = opts;
	const ceil = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
	return Math.floor(random() * ceil);
}

export interface RetryOptions extends BackoffOptions {
	/** Max total attempts (including the first). Default 3. */
	attempts?: number;
	/** Decide whether a thrown error is retryable. Default: always retry. */
	shouldRetry?: (err: unknown, attempt: number) => boolean;
	/** Observe each retry (for logging / a "reconnecting…" UI signal). */
	onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
	/** Injectable sleep for tests (no real timers). */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, retrying with full-jitter backoff. `fn` receives the 0-based attempt index.
 * Throws the last error once attempts are exhausted or `shouldRetry` returns false.
 * Caller owns idempotency — only wrap operations that are safe to repeat (e.g. a
 * pre-first-byte connect, never a half-streamed turn).
 */
export async function retryWithBackoff<T>(
	fn: (attempt: number) => Promise<T>,
	opts: RetryOptions = {}
): Promise<T> {
	const {
		attempts = 3,
		shouldRetry = () => true,
		onRetry,
		sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
		...backoff
	} = opts;
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn(i);
		} catch (err) {
			lastErr = err;
			if (i === attempts - 1 || !shouldRetry(err, i)) throw err;
			const delayMs = jitteredDelay(i, backoff);
			onRetry?.(err, i, delayMs);
			await sleep(delayMs);
		}
	}
	throw lastErr;
}
