// Graceful shutdown on a plain Node host (adapter-node), so an organisation running Alpha in its own
// container can redeploy without cutting answers off or dropping the work queued after a turn.
//
// adapter-node already owns the first half. On SIGTERM it stops accepting connections and waits up to
// SHUTDOWN_TIMEOUT seconds (default 30) for open requests, chat streams included, to end; then it
// emits `sveltekit:shutdown` on `process`. That event is where this module takes over: it waits a
// second window of the same length for background work (vercelBackground.ts's registry), then exits.
// Without it the process either exits with that work half done or lingers on idle sockets until the
// orchestrator's SIGKILL. So the orchestrator's stop grace period should be at least
// 2 × SHUTDOWN_TIMEOUT plus a few seconds.
//
// The event never fires on Vercel or under `vite dev`, so neither changes. Kept free of imports so a
// spec can load it in a child process and send it a real SIGTERM.

type Drain = (timeoutMs: number) => Promise<{ left: number }>;

export interface ShutdownDeps {
	/** The process to listen on; a stand-in in tests. */
	proc?: Pick<NodeJS.Process, "once" | "exit">;
	/** Waits for background work, up to the given ms. */
	drain: Drain;
	/** adapter-node's SHUTDOWN_TIMEOUT, in seconds, read the same way adapter-node reads it. */
	shutdownTimeout?: string | undefined;
	log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** The drain window in ms: SHUTDOWN_TIMEOUT seconds, default 30, matching adapter-node. */
function drainWindowMs(shutdownTimeout: string | undefined): number {
	const seconds = Number.parseInt(shutdownTimeout ?? "30", 10);
	return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 30) * 1000;
}

/** Listen for adapter-node's `sveltekit:shutdown`, drain background work, then exit 0. */
export function installGracefulShutdown(deps: ShutdownDeps): void {
	const proc = deps.proc ?? process;
	const windowMs = drainWindowMs(deps.shutdownTimeout ?? process.env.SHUTDOWN_TIMEOUT);
	const log = deps.log ?? (() => {});
	// `sveltekit:shutdown` is a custom event, outside NodeJS.Process's typed overloads.
	(proc.once as (event: string, listener: (reason: unknown) => void) => unknown)(
		"sveltekit:shutdown",
		(reason) => {
			const started = Date.now();
			void deps
				.drain(windowMs)
				.catch(() => ({ left: -1 }))
				.then(({ left }) => {
					log("Background work drained; exiting", {
						reason,
						left,
						drainMs: Date.now() - started,
						windowMs,
					});
					proc.exit(0);
				});
		}
	);
}
