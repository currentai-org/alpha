// Each long-lived server process keeps its own state fresh: the flag snapshot, the model registry, the
// DB connection, the in-process error counters (warm.ts's process legs). An organisation
// self-hosting Alpha runs one or more Node processes behind a load balancer, and a scheduler calling
// one URL reaches one of them, so the refresh has to come from inside each process.
//
// Never on Vercel: an idle function there is frozen, and a timer would thaw inside a later, real
// request and steal its time (vercelBackground.ts's module comment). Vercel's page ping and cron run
// the same legs instead. Not under `vite dev` either, where nobody wants a DB and flag poll per minute.

/** One tick a minute, matching the scheduled job's cadence (and PG_IDLE_TIMEOUT's coupling to it). */
const KEEPALIVE_INTERVAL_MS = 60_000;

interface KeepaliveOptions {
	/** One keepalive pass. Must not throw; a rejection is swallowed anyway. */
	tick: () => Promise<unknown>;
	intervalMs?: number;
	/** Wait this long before the first pass instead of running it at once. */
	firstDelayMs?: number;
	/** process.env.VERCEL by default. */
	onVercel?: boolean;
}

/** Start this process's keepalive. Returns a stop function, or null when it does not run here (on
 *  Vercel). The first pass runs at once, so a fresh process does not wait a minute for fresh flags,
 *  unless `firstDelayMs` asks it to wait; the interval then counts from that first pass.
 *  A pass still running when the next is due is not doubled up. The timer is unref'd, so it never
 *  holds a stopping process open. */
export function startProcessKeepalive(opts: KeepaliveOptions): (() => void) | null {
	if (opts.onVercel ?? Boolean(process.env.VERCEL)) return null;
	let running = false;
	const pass = () => {
		if (running) return;
		running = true;
		void opts
			.tick()
			.catch(() => {})
			.finally(() => {
				running = false;
			});
	};
	const intervalMs = opts.intervalMs ?? KEEPALIVE_INTERVAL_MS;
	let timer: ReturnType<typeof setInterval> | undefined;
	const startInterval = () => {
		pass();
		timer = setInterval(pass, intervalMs);
		timer.unref?.();
	};
	if (opts.firstDelayMs === undefined) {
		startInterval();
		return () => clearInterval(timer);
	}
	const first = setTimeout(startInterval, opts.firstDelayMs);
	first.unref?.();
	return () => {
		clearTimeout(first);
		clearInterval(timer);
	};
}
