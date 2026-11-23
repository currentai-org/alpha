// The daily cleanup's caller wherever the Vercel cron is not. On Vercel, the cron in vercel.json calls
// routes/chat/api/cleanup with its CRON_SECRET. Anywhere else (a self-hosted Alpha, or a hosted instance
// run off Vercel) nothing calls that route, so each server process runs the cleanup itself, once a day,
// on the same timer the keepalive uses (keepalive.ts: unref'd, never on Vercel, never doubled up). The
// edition does not matter: whoever lacks the cron runs the timer. Replicas each run it; the deletes only
// touch what is already past its date, so a second run the same day deletes nothing more. The first run
// waits a random few minutes so replicas started together do not all run at once, and so a process that
// restarts more often than daily still runs it. Never under `vite dev`; the route is open there instead.
import { startProcessKeepalive } from "$lib/chat/server/keepalive";

const DAILY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first run lands between these two delays after boot. */
const DAILY_CLEANUP_FIRST_RUN_MIN_MS = 60_000;
const DAILY_CLEANUP_FIRST_RUN_MAX_MS = 10 * 60_000;

interface DailyCleanupScheduleOptions {
	/** `vite dev`, where nobody wants a cleanup on a timer (the route is open there instead). */
	dev: boolean;
	/** process.env.VERCEL by default. */
	onVercel?: boolean;
	/** One cleanup run. dailyCleanup.ts's runScheduledCleanup by default. */
	run?: () => Promise<unknown>;
	/** The first run's delay; jittered between the bounds above by default. */
	firstDelayMs?: number;
	random?: () => number;
	/** process.env by default; read for DAILY_CLEANUP_FIRST_RUN_DELAY_MS. */
	env?: Record<string, string | undefined>;
}

/**
 * DAILY_CLEANUP_FIRST_RUN_DELAY_MS replaces the jittered first-run delay with a fixed one, so a CI smoke
 * sees a run seconds after boot instead of up to ten minutes. Anything but a whole number of at least one
 * second is ignored and the jitter applies.
 */
function firstDelayFromEnv(env: Record<string, string | undefined>): number | undefined {
	const raw = env.DAILY_CLEANUP_FIRST_RUN_DELAY_MS?.trim();
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const ms = Number(raw);
	return ms >= 1_000 ? ms : undefined;
}

/** Start this process's daily cleanup. Returns a stop function, or null when it does not run here. */
export function startDailyCleanupSchedule(opts: DailyCleanupScheduleOptions): (() => void) | null {
	if (opts.dev) return null;
	const random = opts.random ?? Math.random;
	const firstDelayMs =
		opts.firstDelayMs ??
		firstDelayFromEnv(opts.env ?? process.env) ??
		DAILY_CLEANUP_FIRST_RUN_MIN_MS + Math.floor(random() * (DAILY_CLEANUP_FIRST_RUN_MAX_MS - DAILY_CLEANUP_FIRST_RUN_MIN_MS));
	return startProcessKeepalive({
		tick: opts.run ?? (async () => (await import("$lib/chat/server/dailyCleanup")).runScheduledCleanup()),
		intervalMs: DAILY_CLEANUP_INTERVAL_MS,
		firstDelayMs,
		onVercel: opts.onVercel,
	});
}
