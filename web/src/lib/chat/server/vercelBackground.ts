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
 *  - elsewhere (dev / adapter-node / tests) the process is long-lived: the work is held in the
 *    shutdown registry below so a SIGTERM drains it before the process exits (gracefulShutdown.ts).
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
	if (process.env.VERCEL) {
		await detached;
		return;
	}
	track(detached);
}

/** Keep the process alive for `work` without awaiting it: Vercel's waitUntil when there is one,
 *  else the shutdown registry below. For call sites that held work open with a bare
 *  `nodeRequestContext().waitUntil?.(p)`, which did nothing on a plain Node host. */
export function keepAlive(work: Promise<unknown>): void {
	const ctx = nodeRequestContext();
	if (ctx.waitUntil) {
		ctx.waitUntil(work);
		return;
	}
	track(work.catch(() => {}));
}

// ── Shutdown registry (plain Node hosts) ─────────────────────────────────────────────────────────
// A long-lived process has no waitUntil, so background work floats. That is safe until the process
// is told to stop: a deploy's SIGTERM would otherwise exit with that work half done. Work scheduled
// without a waitUntil is held here until it settles, and drainBackground waits on what is left.
// Work that went to a waitUntil is never held here: Vercel owns its lifetime.
const pending = new Set<Promise<unknown>>();

function track(settling: Promise<unknown>): void {
	pending.add(settling);
	void settling.finally(() => pending.delete(settling));
}

/** Wait for every held background promise to settle, or for `timeoutMs`, whichever comes first.
 *  Work scheduled while draining is waited on too. Never rejects. `left` is what was still running
 *  when it returned (0 means everything finished); drainBackground(0) just counts. */
export async function drainBackground(timeoutMs: number): Promise<{ left: number }> {
	const deadline = Date.now() + timeoutMs;
	while (pending.size > 0) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, remaining);
		});
		await Promise.race([Promise.allSettled([...pending]), expired]);
		clearTimeout(timer);
	}
	return { left: pending.size };
}
