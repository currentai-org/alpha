// Server-side exception capture → PostHog.
//
// Without it an unhandled server exception is one unstructured log line with no grouping, no count,
// no first/last-seen, and nothing watching it. This gives each exception an issue that answers "is
// this new?" and "how many users hit it?", and that an alert can watch.
//
// Deliberately small. posthog-node is ALREADY a dependency and PUBLIC_POSTHOG_KEY is already set in
// every environment, so this needs no new vendor, no new secret, and no plan change. `captureException`
// gives grouping and counts for free, which is the entire point.
//
// SEPARATE CLIENT from flags.ts on purpose: that module's client is typed to flags only and documents
// "this module never captures events". Sharing it would couple error delivery to the flag plane's
// lifecycle, and a flag refresh failure must not take error reporting with it.
//
// BEST-EFFORT, ALWAYS. This runs inside an error handler — throwing here would replace a real error
// with a reporting error and lose the original. Every failure path returns quietly.
//
// NOT a replacement for the Axiom log line. Axiom keeps the full structured context for debugging;
// this adds grouping and alerting. Both, not either.

import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { serverPosthogHost } from "$lib/chat/server/posthogHost";

/** Only the surface used here — posthog-node's own types are not worth importing for two methods. */
type MinimalPostHog = {
	captureException: (error: unknown, distinctId?: string, properties?: Record<string, unknown>) => void;
	shutdown: () => Promise<void>;
};

let client: MinimalPostHog | undefined;
let initAttempted = false;

/** Errors are attributed to the deployment, not to a user. Tying an exception to a distinct_id would
 *  put it in that person's PostHog timeline, and these are OUR faults, not user actions. */
const DEPLOYMENT_DISTINCT_ID = "aipotluck-server";

function env(key: string): string {
	return ((Reflect.get(config, key) as string | undefined) || "").trim();
}

async function getClient(): Promise<MinimalPostHog | undefined> {
	if (initAttempted) return client;
	initAttempted = true;
	const projectKey = env("PUBLIC_POSTHOG_KEY");
	if (!projectKey) {
		logger.info("[errors] PUBLIC_POSTHOG_KEY unset — exceptions log to Axiom only, no grouping");
		return undefined;
	}
	try {
		const { PostHog } = await import("posthog-node");
		client = new PostHog(projectKey, {
			// NOT env("PUBLIC_POSTHOG_HOST"): a relative browser adblock-proxy path (`/rs`) is not a valid
			// server-side host and silently breaks delivery. See posthogHost.ts (CUR-87).
			host: serverPosthogHost(),
			featureFlagsPollingInterval: 0,
			disableGeoip: true,
			// Serverless: a batching queue that waits for a size threshold loses the event when the
			// instance freezes. Flush per event — the volume is exceptions, not analytics.
			flushAt: 1,
			flushInterval: 0,
		}) as unknown as MinimalPostHog;
		return client;
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[errors] PostHog client init failed — exceptions log to Axiom only"
		);
		return undefined;
	}
}

// ── Rate counter, read by the warm cron ──────────────────────────────────────────────────────────
// PostHog gives grouping and history; it does not page us. Alerting reuses the EXISTING path rather
// than adding a second notifier: this counter feeds a warm leg that calls recordProbe, so errors get
// the same debounce, the same alert webhook and the same alert_state row as every other probe. Same
// shape as warmDeclineRate, which already counts declines over a window.
//
// PER-INSTANCE, and that is a real limitation (CUR-90 tracks the class): each serverless instance has
// its own counter, so the alert fires on "one instance saw N errors", not "the fleet did". That biases
// toward LATE alerting under fan-out, never early — acceptable for a threshold whose job is catching a
// sustained problem, not a single blip. Moving the count to Postgres is the fix when it matters.
let errorCount = 0;

/** Read and RESET the count. Called once per warm tick; resetting on read is what makes the value a
 *  rate over the tick interval rather than an unbounded total. */
export function takeErrorCount(): number {
	const n = errorCount;
	errorCount = 0;
	return n;
}

/** Report a server exception. Never throws, never rejects meaningfully — callers are error handlers.
 *
 *  `errorId` should be the same id returned to the user, so a support report ("I saw error abc123")
 *  maps to one grouped exception without a log search. */
export async function captureServerException(
	error: unknown,
	context: {
		errorId?: string;
		url?: string;
		routeId?: string | null;
		status?: number;
		method?: string;
	} = {}
): Promise<void> {
	// Counted BEFORE the client check, so the rate alert still works with PostHog unconfigured or down.
	// Alerting must not depend on the analytics vendor being reachable.
	errorCount++;
	try {
		const ph = await getClient();
		if (!ph) return;
		ph.captureException(error, DEPLOYMENT_DISTINCT_ID, {
			// No request bodies, no headers, no user text: an exception report must not become a
			// side channel for conversation content.
			error_id: context.errorId,
			$current_url: context.url,
			route_id: context.routeId ?? undefined,
			status: context.status,
			method: context.method,
		});
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[errors] captureException failed (swallowed — error reporting is best-effort)"
		);
	}
}
