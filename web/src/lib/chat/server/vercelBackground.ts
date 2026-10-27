// Background work that must SURVIVE the response on Vercel. A fire-and-forget promise in a Vercel
// Node function is FROZEN the instant the response returns: the work then thaws INSIDE later, real
// requests (stealing their CPU on the hot path), abort timers fire spuriously on thaw (their deadline
// passed while frozen), and a cron caller's work never actually runs. The log signature is [warm] leg
// times in the hundreds of seconds, the embeddings warm aborting every cycle, and pino timestamps
// trailing Vercel's log capture by 30–40s.

type WaitUntil = (p: Promise<unknown>) => void;

/** The Vercel NODE-runtime request context. adapter-vercel only populates `platform.context` on the
 *  EDGE runtime — Node functions expose the context (and its `waitUntil`) behind
 *  `Symbol.for("@vercel/request-context")` on globalThis: the same public symbol contract
 *  @vercel/functions' getContext() reads (that helper isn't reachable through the package's exports
 *  map, hence the direct read). Returns {} outside Vercel (dev, adapter-node, tests). */
export function nodeRequestContext(): { waitUntil?: WaitUntil } {
	const store = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
		| { get?: () => { waitUntil?: WaitUntil } | undefined }
		| undefined;
	return store?.get?.() ?? {};
}

/** Run best-effort `work` in the background such that it ACTUALLY runs to completion:
 *  - with a `waitUntil` (the caller's edge `platform.context`, or the Node request context), schedule
 *    and return immediately — the response goes out now, the function stays alive until `work` settles;
 *  - on Vercel with NO waitUntil, await inline — a slower response, but correct (see module comment);
 *  - elsewhere (dev / adapter-node / tests) the process is long-lived, so the floating promise is safe.
 *  waitUntil is always invoked as a METHOD on its owning context (an extracted reference can lose its
 *  `this` and throw on some context implementations). Swallows `work`'s rejection either way —
 *  background work is best-effort by definition here. */
export async function runInBackground(
	work: Promise<unknown>,
	edgeContext?: { waitUntil?: WaitUntil }
): Promise<void> {
	const detached = work.catch(() => {});
	const ctx = edgeContext?.waitUntil ? edgeContext : nodeRequestContext();
	if (ctx.waitUntil) {
		ctx.waitUntil(detached);
		return;
	}
	if (process.env.VERCEL) await detached;
}
