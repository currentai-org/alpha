import { config } from "$lib/chat/server/config";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { countLiveEvents, recordEvent, recordEvents, secondsUntilRoom } from "$lib/chat/server/db/eventWindow";
import { usageLimits } from "$lib/chat/server/usageLimits";
import { logger } from "$lib/chat/server/logger.js";
import { ERROR_MESSAGES } from "$lib/chat/stores/errors";
import type { MessageEvent } from "$lib/chat/types/MessageEvent";
import { error } from "@sveltejs/kit";
import { recordRateLimitTrip } from "$lib/chat/server/alerting";

/**
 * Enforce the per-turn request limits before a generation runs. Records the turn for
 * rate-limit bookkeeping and applies three independent guardrails:
 *
 *   1. Per-SESSION per-minute limit — the fair, NAT-safe primary limit. A guest's session is a
 *      signed value the server minted (guestSession.ts, CUR-3191), so a made-up cookie no longer
 *      starts a fresh budget.
 *   2. Per-IP per-minute ceiling — ON by default as a high abuse backstop (see DEFAULT_IP_MULTIPLIER).
 *      It bounds a caller who drops the cookie to be minted a new session on every send.
 *   3. Service-wide DAILY request cap — a cost/abuse backstop for the limited compute budget. It
 *      FAILS CLOSED: when the count cannot be read the turn gets a 503 that says why.
 *
 * The bookkeeping insert and the two per-minute counts fail open: a DB blip must never take down a
 * turn (a transient insert failure here must not 500 the request). An over-limit count throws a
 * 429 via `error()`, which propagates out of the route handler.
 */
/**
 * The per-IP ceiling is this many times the per-session rate when RATE_LIMIT_IP_MULTIPLIER
 * is unset. At the default RATE_LIMIT of 20 that is 500 messages a minute from one IP.
 *
 * Sized for a room, not a person. A conference or live demo puts a few hundred visitors behind one
 * conference NAT address; 300 of them each sending once in the same minute is 300, under 500. A
 * script that rotates sessions from one address is held to 500 a minute where it had no bound.
 * RATE_LIMIT_IP_MULTIPLIER still overrides it, and 0 turns the ceiling off. (CUR-3191)
 */
const DEFAULT_IP_MULTIPLIER = 25;

/** The per-IP ceiling's refusal. Names the shared-network case so a room at an event reads it as
 *  "wait a minute", not as a fault. Contains "too many messages" so the composer holds it
 *  (isRateLimitMessage) and keeps the unsent text. */
const IP_CEILING_MESSAGE =
	"Too many messages are coming from your network right now. If you're at an event sharing Wi-Fi, wait a minute and try again.";

/** The daily cap could not be counted. Contains "request limit" so the composer holds it. */
const DAILY_CAP_UNCHECKED_MESSAGE =
	"We couldn't check today's request limit, so new messages are paused for a moment. Please try again in a minute.";

function ipMultiplier(): number {
	const raw = Reflect.get(config, "RATE_LIMIT_IP_MULTIPLIER");
	if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_IP_MULTIPLIER;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IP_MULTIPLIER;
}

export async function enforceRequestRateLimits(opts: {
	userId: MessageEvent["userId"];
	clientAddress: string;
	/** The per-session limit and window in place of `messagesPerMinute` and a minute. Set only by the
	 *  route's `session_rate_limit_low` fault (CUR-2804), so a spec can trip the limit and outwait it. */
	perSession?: { limit: number; windowMs: number };
	/** Which count this request joins. "conversationCreate" (CUR-3529) is the create route's own
	 *  budget at the same per-session and per-IP rates: kept apart from turns so a create never spends
	 *  the turn it precedes, and left out of the daily cap, which counts model calls. */
	event?: "message" | "conversationCreate";
}): Promise<void> {
	const { userId, clientAddress } = opts;
	const type = opts.event ?? "message";
	const perSessionLimit = opts.perSession?.limit ?? usageLimits?.messagesPerMinute;

	// Register the event for ratelimiting — best-effort. Rate-limit bookkeeping is infrastructure and
	// must NEVER take down a turn: a DB blip here must not 500 the request before the model runs.
	// Fire-and-forget (not awaited): the worst case of a failed OR still-in-flight insert
	// is one un-recorded event for the perSession count just below — a slight under-count that is already
	// the documented acceptable case for a soft per-minute limit, so there's nothing gained by blocking the
	// turn on this write landing before we proceed.
	// Count against the SAME keyed hash we store here (domain "rate-limit"). When no pepper is
	// configured hashIp returns null and the row carries no ipHash.
	const ipHash = hashIp(clientAddress, "rate-limit") ?? undefined;
	const windowMs = opts.perSession?.windowMs ?? 60_000;
	const recorded = recordEvent({ type, userId, ipHash }, windowMs, "rate-limit");
	// The fault's override waits for this send's own row, so the count below always includes it. Left
	// to race, a limit of one refused the second send only when the insert won (CUR-2804).
	if (opts.perSession) await recorded;
	else void recorded;

	if (perSessionLimit) {
		// Per-SESSION limit (each guest/user has a unique sessionId) — the fair, NAT-SAFE primary
		// limit: one person can't spam, but classmates sharing a public IP behind a NAT each get their
		// own budget. (A per-IP limit at the per-person rate would lock out a whole
		// NAT'd classroom at once — exactly the education audience this alpha targets.)
		// Fail open on a count error (DB blip) — same posture as the global daily cap below: a limiter
		// failure must not block a turn. Only an actual over-limit count (not a failed count) 429s.
		const perSession = await countLiveEvents({ type, userId }, "rate-limit:session");
		if (perSession !== null && perSession > perSessionLimit) {
			// fire-and-forget, same posture as the bookkeeping insert above — alerting on abuse
			// must never add latency to (or block) the 429 already being sent. userId is an opaque
			// session/user id, not a raw IP or email; fine to include in the alert for correlation. (CUR-1134)
			void recordRateLimitTrip(`chat-rate-limit:session:${userId}`, {
				limitName: "per-session/minute",
				identity: String(userId),
			});
			// Say how long, so the composer can hold Send and count down instead of leaving a
			// live button whose every press (recorded above) pushes the window further out. A wait that
			// can't be read falls back to the whole window, never to no wait (CUR-3410). (CUR-3216)
			const retryAfterSeconds =
				(await secondsUntilRoom({ type, userId }, perSessionLimit, "rate-limit:session")) ||
				Math.ceil(windowMs / 1000);
			error(429, { message: ERROR_MESSAGES.rateLimited, retryAfterSeconds });
		}
		// Per-IP ceiling, ON by default (CUR-3191) and deliberately loose: a conference or
		// lecture-hall NAT puts hundreds of phones behind ONE address, so this is a room-sized abuse
		// backstop and never the per-person rate. Sizing is on DEFAULT_IP_MULTIPLIER.
		const multiplier = ipMultiplier();
		// With no ipHash (no pepper configured) we skip the ceiling (fail open) rather than count rows
		// where ip_hash IS NULL, which would conflate every unhashed event into one bucket.
		if (multiplier > 0 && !ipHash) {
			logger.warn("[rate-limit] no IP pepper configured, so the per-IP ceiling is not enforced");
		}
		if (multiplier > 0 && ipHash) {
			const perIp = await countLiveEvents({ type, ipHash }, "rate-limit:ip");
			if (perIp !== null && perIp > perSessionLimit * multiplier) {
				// ipHash only, never the raw client IP — same domain-separated hash already
				// stored on the message event. (CUR-1134)
				void recordRateLimitTrip(`chat-rate-limit:ip:${ipHash}`, {
					limitName: "per-IP/minute",
					identity: `ip-hash ${ipHash.slice(0, 12)}…`,
				});
				// A room at an event gets a held Send and a countdown too, not a live button. (CUR-3410)
				const retryAfterSeconds =
					(await secondsUntilRoom({ type, ipHash }, perSessionLimit * multiplier, "rate-limit:ip")) ||
					Math.ceil(windowMs / 1000);
				error(429, { message: IP_CEILING_MESSAGE, retryAfterSeconds });
			}
		}
	}

	// Service-wide DAILY request cap — a cost/abuse guardrail for the limited CSCS/HF compute budget,
	// distinct from the per-user/per-IP per-minute limit above. Counts requests in a rolling 24h window
	// via a dedicated "globalDaily" messageEvent (the table + cleanup already GC by expiresAt). The DB
	// count is approximate (the best-fit for serverless — no Redis): a brief overshoot under concurrency
	// is acceptable for a soft cap. A count that fails is FAIL-CLOSED (CUR-3191): the cap is the spend
	// backstop, and a store that cannot answer this one count is the same store every turn already
	// needs for the conversation it writes to, so refusing here costs little a DB failure had not
	// already cost. The 503 says what happened, so it reads as a pause rather than a broken app.
	// Disabled when the env var is unset/0.
	const globalDailyCap = Number(config.GLOBAL_DAILY_REQUEST_CAP) || 0;
	if (globalDailyCap > 0 && type === "message") {
		const dailyCount = await countLiveEvents({ type: "globalDaily" }, "rate-limit:daily");
		if (dailyCount === null) {
			logger.error("[rate-limit] global daily cap could not be counted — refusing the turn (fail closed)");
			error(503, DAILY_CAP_UNCHECKED_MESSAGE);
		}
		if (dailyCount >= globalDailyCap) {
			logger.warn({ dailyCount, globalDailyCap }, "[rate-limit] global daily request cap reached");
			// Single global key — the daily cap has no per-offender identity, it IS the alert. (CUR-1134)
			void recordRateLimitTrip("chat-rate-limit:daily-cap", {
				limitName: "global daily request cap",
				identity: `${dailyCount}/${globalDailyCap} requests today`,
			});
			error(429, "The service has reached today's request limit. Please try again later.");
		}
		// Record this request in the 24h window (best-effort — a failed insert just under-counts).
		// Fire-and-forget: nothing downstream reads this insert's result, so awaiting it only adds a
		// blocking DB round trip to the pre-stream critical path.
		void recordEvent({ type: "globalDaily", userId, ipHash }, 24 * 60 * 60_000, "rate-limit:daily");
	}
}

/**
 * Charge a turn for the guard chunks its input screen read, past the first. The screen
 * re-reads the whole conversation (up to 9 chunks of one judge call per rule), so a guest with a long
 * history costs the guard about nine times what a short turn does. The extra rows join the turn's own
 * per-session and per-IP rows, which every server instance counts, so the next turn over the limit is
 * refused whichever instance answers. Recorded after the screen and never awaited by the turn: the
 * charge lands on the next turn, and a failed write fails open like the rest of this file. (CUR-3532)
 */
export async function chargeScreeningCost(opts: {
	userId: MessageEvent["userId"];
	clientAddress: string;
	guardChunks: number;
}): Promise<void> {
	const extra = Math.floor(opts.guardChunks) - 1;
	if (!(extra > 0)) return;
	const ipHash = hashIp(opts.clientAddress, "rate-limit") ?? undefined;
	await recordEvents({ type: "message", userId: opts.userId, ipHash }, extra, 60_000, "rate-limit:screening");
}

