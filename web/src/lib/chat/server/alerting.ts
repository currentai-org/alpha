// One home for ops alerting. A health probe reports healthy/unhealthy for an alert KEY; this decides
// whether to notify and debounces so an ongoing outage doesn't spam. State lives in the `alert_state`
// table — ONE ROW per key (see db/schema.ts) — so every future alert reuses THIS path with a new key
// instead of a new table or a second bespoke notifier. Notification target is the alert webhook
// (SLACK_ALERT_WEBHOOK); the app posts to it directly. EVERYTHING here is BEST-EFFORT — a warm/health leg must never break because
// alerting hiccuped, so nothing in this module throws.

import { eq } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { alertState } from "$lib/chat/server/db/schema";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { logger, securityLogger } from "$lib/chat/server/logger";
import { postSlackWebhook } from "../../../../scripts/lib/slackWebhook.mjs";

// Consecutive UNHEALTHY probes before firing — a single blip / cold-start never reaches it; sustained
// failure does. With the ~3-min Coop probe throttle (warm.ts), 3 ⇒ ~6–9 min to fire.
const FIRE_THRESHOLD = 3;
// Don't re-notify an ONGOING outage more often than this.
const REALERT_MS = 30 * 60_000;
// Consecutive rate-limit TRIPS (not probes) before firing. Higher than FIRE_THRESHOLD —
// these are discrete per-request events, not spaced-out health checks, so a legitimate retry burst
// (a flaky connection, a person mashing send) shouldn't page anyone. 5 back-to-back trips from the
// SAME identity is past what normal use produces. (CUR-1134)
const TRIP_FIRE_THRESHOLD = 5;

type ProbeOpts = {
	/** Human label for the alert body, e.g. "Coop verdict path". */
	label: string;
	/** One-line runbook appended to a FIRING alert — what it means / what to check. */
	runbook: string;
	/** How bad is this for a USER mid-turn, which is not the same as how broken the dependency is.
	 *  "outage" (default) = the product stops working (no model, no DB, moderation fail-closed).
	 *  "degraded" = a documented fail-open path absorbs it and turns still answer, just worse (RAG
	 *  embeddings fall back to regex, the router catalog goes unconsulted). Only the wording differs —
	 *  same threshold, same debounce — but a channel that shouts DOWN when nothing is down gets muted,
	 *  and a muted channel is worse than no channel. */
	severity?: "outage" | "degraded";
};

type AlertVals = {
	consecutiveFailures: number;
	firing: boolean;
	lastFiredAt: Date | null;
	updatedAt: Date;
};

/** POST {"text": …} to the alert webhook. No-op (info log) when unset. Never throws. A delivered
 *  alert logs its key and never its text, which can name a person, so a later check can confirm the
 *  page went out (CUR-4165). */
async function postSlack(key: string, text: string): Promise<void> {
	const url = firstKey(["SLACK_ALERT_WEBHOOK"], "slackAlertWebhook", { allowEmpty: true });
	if (!url) {
		logger.info({ alert_key: key, alert: text }, "[alert] SLACK_ALERT_WEBHOOK unset — alert computed but not delivered");
		return;
	}
	try {
		await postSlackWebhook(url, text, { timeoutMs: 8_000 });
		logger.info({ alert_key: key }, "[alert] delivered");
	} catch (e) {
		logger.warn(
			{ alert_key: key, err: e instanceof Error ? e.message : String(e) },
			"[alert] Slack webhook POST failed"
		);
	}
}

async function upsert(key: string, vals: AlertVals): Promise<void> {
	await getDb()
		.insert(alertState)
		.values({ key, ...vals })
		.onConflictDoUpdate({ target: alertState.key, set: vals });
}

// ── Per-dependency heartbeats → public status page (CUR-102) ─────────────────────────────────────
// The status page reports our EXTERNAL dependencies, and this is where that signal comes from. Same
// inversion as the cron's own dead-man's switch: Better Stack expects to HEAR from us, so we ping ONLY
// on a healthy probe and a failing dependency goes red by SILENCE. Withholding a ping is the signal.
//
// Deliberately hung off recordProbe rather than the warm legs: every leg already funnels its outcome
// through here, so there is one place that decides "is this dependency healthy" for both the alert webhook and the
// public page. Two independent health computations would eventually disagree, and disagreeing publicly
// is worse than either answer alone.
//
// GRACE PERIOD IS A CONTRACT, NOT A KNOB. The alert webhook only fires after FIRE_THRESHOLD consecutive failures;
// the Better Stack grace period is that debounce expressed in time. Set it too short and the public page
// goes red while the webhook is silent; too long and we page while the page still claims green. It must also
// clear the SLOWEST probe interval — coop self-throttles to ~3 min, and a throttled probe never calls
// recordProbe at all, so a grace under ~3 min would red a perfectly healthy dependency. Rule of thumb:
// grace >= FIRE_THRESHOLD × slowest-probe-interval.
//
// PROD ONLY, and self-gating: the URLs are set in production only, so preview/local resolve to unset and
// this no-ops. One heartbeat shared across environments would let preview hold a component green while
// prod is dead — the same trap documented on BETTERSTACK_HEARTBEAT_URL.
export const HEARTBEAT_ENV_BY_KEY: Record<string, string> = {
	"model:warm": "BETTERSTACK_HB_MODEL_URL",
	"embeddings:warm": "BETTERSTACK_HB_EMBEDDINGS_URL",
	"db:warm": "BETTERSTACK_HB_DB_URL",
	"catalog:warm": "BETTERSTACK_HB_CATALOG_URL",
	// "Safety filtering" component. coop:verdict is the pre-Shieldstral sync-detector probe, still
	// pinged when guard-primary is off; guard:verdict is its replacement (CUR-1041) — Shieldstral going
	// primary silences coop:verdict entirely (see warm.ts), so without this entry the heartbeat this
	// component depends on goes silent forever the moment guard-primary flips on, and the public status
	// page reds a dependency that's actually healthy. Same env var: it's still the same status-page
	// component, just a different upstream detector serving it.
	"coop:verdict": "BETTERSTACK_HB_COOP_URL",
	"guard:verdict": "BETTERSTACK_HB_COOP_URL",
	"moderation:failclosed": "BETTERSTACK_HB_DECLINES_URL",
};

/** Ping the per-dependency heartbeat for `key`. Called ONLY on a healthy probe — see above, silence is
 *  the failure signal. No-op when the key has no heartbeat or the URL is unset. Never throws. */
async function pingDependencyHeartbeat(key: string): Promise<void> {
	const envVar = HEARTBEAT_ENV_BY_KEY[key];
	if (!envVar) return; // probe with no status-page component — nothing to report
	const url = firstKey([envVar], "betterstackDependencyHeartbeat", { allowEmpty: true });
	if (!url) return; // unset (preview, local, or before Doppler sync) — not an error
	try {
		const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
		// fetch RESOLVES on 4xx/5xx. Checking status explicitly because the alternative is a heartbeat
		// that logs ok through a rotated URL and holds a PUBLIC component green while the dependency is
		// down.
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		logger.info({ leg: "heartbeat-dependency", key, ok: true }, "[warm] leg");
	} catch (e) {
		// Swallowed: failing to reach Better Stack must never break the warm leg that called us. The
		// consequence of a persistent failure is that the component reds and BETTER STACK ALERTS US.
		logger.warn(
			{ leg: "heartbeat-dependency", key, ok: false, err: e instanceof Error ? e.message : String(e) },
			"[warm] leg"
		);
	}
}

/** Record one probe outcome for `key` and notify on the healthy↔unhealthy transitions, debounced by the
 *  alert_state row: fires once when consecutiveFailures crosses FIRE_THRESHOLD (re-fires at most every
 *  REALERT_MS while still down), and posts a single recovery line when it comes back. Best-effort — logs
 *  and returns on any error, never throws (callers are warm legs). Pass `healthy=null`-callers should
 *  simply not call this (a skipped probe records nothing). */
export async function recordProbe(key: string, healthy: boolean, opts: ProbeOpts): Promise<void> {
	// BEFORE the try, deliberately. Everything below needs the alert_state DB, and if that read throws we
	// fall into the catch and return — which would withhold the ping and red a PUBLIC component for a
	// dependency that just reported healthy. The public status page must not be a function of our own
	// alerting database being reachable.
	if (healthy) await pingDependencyHeartbeat(key);

	try {
		const db = getDb();
		const [row] = await db.select().from(alertState).where(eq(alertState.key, key));
		const prevFailures = row?.consecutiveFailures ?? 0;
		const wasFiring = row?.firing ?? false;
		const lastFiredAt = row?.lastFiredAt ?? null;
		const now = new Date();

		if (healthy) {
			// Reset. Only touch the row / announce recovery if there was something to clear.
			if (wasFiring || prevFailures > 0) {
				await upsert(key, { consecutiveFailures: 0, firing: false, lastFiredAt, updatedAt: now });
			}
			if (wasFiring) {
				await postSlack(
					key,
					`🟢 aipotluck prod — ${opts.label} recovered (healthy probe after ${prevFailures} consecutive failures).`
				);
			}
			return;
		}

		// Unhealthy.
		const failures = prevFailures + 1;
		const dueToFire =
			failures >= FIRE_THRESHOLD &&
			(!wasFiring || !lastFiredAt || now.getTime() - lastFiredAt.getTime() >= REALERT_MS);
		await upsert(key, {
			consecutiveFailures: failures,
			firing: failures >= FIRE_THRESHOLD ? true : wasFiring,
			lastFiredAt: dueToFire ? now : lastFiredAt,
			updatedAt: now,
		});
		if (dueToFire) {
			const [icon, state] = opts.severity === "degraded" ? ["🟠", "DEGRADED"] : ["🔴", "DOWN"];
			await postSlack(
				key,
				`${icon} aipotluck prod — ${opts.label} ${state} (${failures} consecutive failed health probes). ${opts.runbook}`
			);
		}
	} catch (e) {
		logger.warn(
			{ key, err: e instanceof Error ? e.message : String(e) },
			"[alert] recordProbe failed (swallowed — alerting is best-effort)"
		);
	}
}

/**
 * Record one chat rate-limit trip for `key` (a hashed IP or an opaque session/user id — never
 * a raw IP or email) and alert on SUSTAINED abuse. Reuses recordProbe's exact debounce shape — same
 * `alert_state` table, a new key namespace, not a new table or a second bespoke notifier — but counts
 * discrete trip events rather than spaced-out probe failures, so it has its own threshold
 * (TRIP_FIRE_THRESHOLD) and never resets on a "healthy" call: nothing about a rate limiter has a
 * natural "back to healthy" moment, so the row just stops updating once the offender stops tripping it,
 * and a NEW debounce window opens automatically after REALERT_MS if they resume. Fire-and-forget from
 * the caller (never awaited) — enforcing a 429 must not wait on this. Best-effort, never throws. (CUR-1134)
 */
export async function recordRateLimitTrip(
	key: string,
	opts: { limitName: string; identity: string }
): Promise<void> {
	// Every trip is a security event, whether or not it is enough to page anyone. (CUR-4143)
	securityLogger.warn({ event: "rate-limit-trip", key, limitName: opts.limitName }, "[security] rate-limit trip");
	try {
		const db = getDb();
		const [row] = await db.select().from(alertState).where(eq(alertState.key, key));
		const trips = (row?.consecutiveFailures ?? 0) + 1;
		const wasFiring = row?.firing ?? false;
		const lastFiredAt = row?.lastFiredAt ?? null;
		const now = new Date();
		const dueToFire =
			trips >= TRIP_FIRE_THRESHOLD &&
			(!wasFiring || !lastFiredAt || now.getTime() - lastFiredAt.getTime() >= REALERT_MS);
		await upsert(key, {
			consecutiveFailures: trips,
			firing: trips >= TRIP_FIRE_THRESHOLD ? true : wasFiring,
			lastFiredAt: dueToFire ? now : lastFiredAt,
			updatedAt: now,
		});
		if (dueToFire) {
			await postSlack(
				key,
				`🟠 aipotluck prod — ${opts.limitName} tripped ${trips} times by ${opts.identity}. Possible scripted abuse.`
			);
		}
	} catch (e) {
		logger.warn(
			{ key, err: e instanceof Error ? e.message : String(e) },
			"[alert] recordRateLimitTrip failed (swallowed — alerting is best-effort)"
		);
	}
}

/**
 * Clear a previously-recorded trip for `key` once its underlying condition is no longer
 * true — for a trigger with no natural time-based decay (a STOCK, not a rate; see
 * recordRateLimitTrip's own contract above, which is right for a rolling window that empties on
 * its own and wrong for a state that stays true until something changes it). A quota check is the
 * motivating case: once storage is full, every retry re-trips the same never-resetting counter and
 * pages every REALERT_MS indefinitely, because nothing about the condition itself ever tells
 * recordRateLimitTrip "this stopped." Call this from the success path once the caller has just
 * confirmed the condition no longer holds.
 *
 * Deliberately silent, not a "recovered" announcement: recordProbe's healthy-transition message
 * makes sense for a dependency outage a human was told about, but a routine successful upload from
 * someone who is comfortably under quota (the overwhelmingly common case) would spam a
 * "custodial storage quota recovered" line that nobody asked for and reads as noise. This only
 * matters — and only writes anything — when a trip was actually in flight. Best-effort, never
 * throws, never awaited by callers (same fire-and-forget posture as recordRateLimitTrip). (CUR-1318)
 */
export async function clearRateLimitTrip(key: string): Promise<void> {
	try {
		const db = getDb();
		const [row] = await db.select().from(alertState).where(eq(alertState.key, key));
		if (!row || (row.consecutiveFailures === 0 && !row.firing)) return; // nothing to clear
		await upsert(key, {
			consecutiveFailures: 0,
			firing: false,
			lastFiredAt: row.lastFiredAt,
			updatedAt: new Date(),
		});
	} catch (e) {
		logger.warn(
			{ key, err: e instanceof Error ? e.message : String(e) },
			"[alert] clearRateLimitTrip failed (swallowed — alerting is best-effort)"
		);
	}
}

/**
 * A CSAM hash match, one alert per occurrence — deliberately NOT routed through
 * recordRateLimitTrip's debounce (repeated identical alerts are the correct behavior here; the
 * failure mode a debounce exists to prevent, a noisy repeat offender, is not the risk a single
 * confirmed match carries). Fire-and-forget from the caller, best-effort, never throws — same posture
 * as every other function in this file. (CUR-1136)
 */
export async function recordCsamMatch(
	identity: string,
	details: { bankName: string; bankContentId: number; distance: string },
	// The custodial-storage caller quarantines the file; the chat-message upload guard
	// refuses the request outright and never writes anything — the alert text needs to say which. (CUR-986)
	disposition: "quarantined" | "refused" = "quarantined"
): Promise<void> {
	try {
		const dispositionText =
			disposition === "quarantined" ? "File quarantined." : "Upload refused, nothing stored.";
		await postSlack(
			"csam-match",
			`🔴 aipotluck — CSAM hash match on upload by ${identity}: bank "${details.bankName}", ` +
				`content id ${details.bankContentId}, distance ${details.distance}. ${dispositionText}`
		);
	} catch (e) {
		logger.warn(
			{ identity, err: e instanceof Error ? e.message : String(e) },
			"[alert] recordCsamMatch failed (swallowed — alerting is best-effort)"
		);
	}
}
