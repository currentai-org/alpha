// CUR-1886. Send the user's answer with real roles first, and fall back to the flattened shape only
// when that attempt fails.
//
// Why: flattenForApertus.ts (CUR-1294) sends the whole conversation as one user message, so every
// earlier answer reaches the model as `[ASSISTANT] …` text inside the question, and the model treats
// that text as material to reuse. The flattened shape opens a later answer with the earlier answer's
// text (the "second answer starts with the first answer" failure and the cross-turn "I'm a machine
// — {model}…" openers); the role-shaped one does not.
//
// Why flatten cannot simply go: the gateway pools two Apertus deployments at equal weight, and only
// one of them serves roles; the other does not take an assistant role. `disable_fallbacks`
// (gatewayFallbackGate.ts, already sent on this lane) keeps a rejected request inside the model group
// rather than handing it to SEA-LION, but the gateway may not retry it on the other deployment, so a
// role-shaped request can come back as the other deployment's 400. So
// apertusStrictLane.ts (CUR-2092) pins the native attempt to the role-accepting deployment, and if
// that attempt fails the flattened resend reaches either deployment.
//
// A workaround with the same delete condition as flatten: when the gateway serves roles on every
// deployment (CUR-1209, CUR-1048), delete this module and flattenForApertus.ts together.

import { isRateLimited } from "../retryPolicy";

/**
 * How long the native attempt runs alone before the flattened request is sent alongside it (CUR-2012).
 *
 * A streaming response sends its headers with the first token, so this is a wait on the model itself.
 * Native attempts that served on production took p50 1.5s, p90 3.5s, and 11 of 145 took over 5s. A
 * plain cutoff at this value would discard a quarter of good attempts; the hedge keeps them racing
 * instead. Failed attempts hang for the full timeout (15s under a plain cutoff), so their cost is
 * about 3s plus the flattened request's own first token.
 */
const NATIVE_HEDGE_AFTER_MS = 3_000;

type ServedShape = "native" | "flat-retry";

export type NativeFirstOutcome<T> = {
	result: T;
	shape: ServedShape;
	/** Why the flattened request was sent. Absent when native served without one. */
	reason?: string;
};

function describe(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}


/**
 * Run `attempt` with native messages. If it fails, or returns no headers within `hedgeAfterMs`, send
 * the flattened messages too and serve whichever returns headers first; the other is aborted.
 *
 * `attempt` must resolve when the response HEADERS arrive (the OpenAI SDK's `create()` does), so the
 * race is decided before any text streams and the loser is cancelled, never read.
 *
 * A caller abort is not a failure of the shape: it propagates immediately and no flattened request is
 * sent, because the person who asked has gone.
 */
export async function withNativeFirst<M, T>(opts: {
	native: M;
	flat: () => M;
	attempt: (messages: M, signal: AbortSignal | undefined) => Promise<T>;
	signal?: AbortSignal;
	hedgeAfterMs?: number;
}): Promise<NativeFirstOutcome<T>> {
	const { native, flat, attempt, signal } = opts;
	const hedgeAfterMs = opts.hedgeAfterMs ?? NATIVE_HEDGE_AFTER_MS;
	const withCaller = (s: AbortSignal) => (signal ? AbortSignal.any([signal, s]) : s);

	const nativeCtl = new AbortController();
	const flatCtl = new AbortController();

	return new Promise<NativeFirstOutcome<T>>((resolve, reject) => {
		let settled = false;
		let nativeError: unknown;
		let nativeDone = false;
		let flatStarted = false;
		let flatDone = false;
		let hedgeReason: string | undefined;

		const finish = (outcome: NativeFirstOutcome<T>, loser: AbortController) => {
			if (settled) return;
			settled = true;
			clearTimeout(hedge);
			loser.abort(new Error("the other shape answered first"));
			resolve(outcome);
		};
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(hedge);
			nativeCtl.abort(err);
			flatCtl.abort(err);
			reject(err);
		};

		const startFlat = (reason: string) => {
			if (flatStarted || settled) return;
			flatStarted = true;
			hedgeReason = reason;
			attempt(flat(), withCaller(flatCtl.signal)).then(
				(result) => finish({ result, shape: "flat-retry", reason: hedgeReason }, nativeCtl),
				(err) => {
					flatDone = true;
					if (signal?.aborted) return fail(err);
					// Both shapes failed: surface the flattened error, as the old resend did.
					if (nativeDone) fail(err);
				}
			);
		};

		const hedge = setTimeout(() => startFlat(`no headers in ${hedgeAfterMs}ms`), hedgeAfterMs);

		attempt(native, withCaller(nativeCtl.signal)).then(
			(result) =>
				finish(
					flatStarted
						? { result, shape: "native", reason: `native won the hedge (${hedgeReason})` }
						: { result, shape: "native" },
					flatCtl
				),
			(err) => {
				nativeDone = true;
				nativeError = err;
				if (signal?.aborted) return fail(err);
				// A rate limit surfaces as itself for the caller's busy handling; a flattened request
				// the hedge already sent keeps racing, since it was sent for a different reason.
				// A 429 says the lane is over its rate. The roles were never judged, so a flattened copy only
				// spends the next slot of the same budget (CUR-2330).
				if (!flatStarted && isRateLimited(err)) return fail(err);
				if (!flatStarted) startFlat(describe(err));
				else if (flatDone) fail(nativeError);
			}
		);
	});
}
