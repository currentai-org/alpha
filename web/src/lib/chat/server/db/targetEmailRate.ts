/**
 * DB-backed backstop for createTargetEmailRateLimiter's in-memory Maps (betterAuth.ts) — those
 * are per-serverless-instance, acknowledged in their own comment as "best-effort, in-memory, per-
 * instance... not a distributed guarantee." On Vercel's per-instance model, fanning requests across
 * instances bypasses the 3-per-10-min OTP cap and the 10-per-10-min invite cap entirely, since each
 * fresh instance's Map starts empty for the same target email.
 *
 * Reuses the message_events table rather than adding a new one. The target email is NOT stored raw —
 * an email is a stronger direct identifier than an IP, and this table already has a migration
 * (0004_hash_message_event_ips.sql) whose sole purpose was purging raw identifiers from it. Same
 * secret-peppered, domain-separated HMAC as every other identifier on this table (see db/ipHash.ts).
 * Two different row shapes below, NEITHER of which puts a real internal user id in `userId` — that
 * column just happens to be the second indexed text column on this table (message_events_user_idx
 * covers (user_id, type, expires_at), matching message_events_ip_hash_idx's own (ip_hash, type,
 * expires_at) shape), so it's reused to carry a second hash where a row needs two:
 *   - targetEmailSendAllowed/recordTargetEmailSend: one hash (the target email), stored in `ipHash`.
 *   - otpSourceSendAllowed/recordOtpSourceSend: TWO hashes on one row — the source IP in `ipHash`
 *     and the target email in
 *     `userId`, so a single countDocuments can filter on the (ip, target) PAIR at once. `userId` never
 *     holds a real user id anywhere in this file — it is not a precedent for "userId = real id", the
 *     way every OTHER table in this schema uses it.
 * A distinct `type` per kind keeps the OTP and invite caps independent, mirroring the two separate
 * in-memory limiters they backstop. Counted through eventWindow.ts, like workspaceInviteRate.ts.
 *
 * Kept ALONGSIDE, not instead of, the in-memory limiter it backstops — the in-memory check is instant
 * (no DB round trip) and catches the common single-instance case; this is the distributed backstop for
 * the fan-out case the in-memory Map structurally cannot see.
 *
 * FAIL OPEN, same posture as every other cap on this table: a DB blip (or no pepper configured) must
 * never block a legitimate send. (CUR-920)
 */
import { recordEvent, underEventLimit } from "$lib/chat/server/db/eventWindow";
import { hashIp, hashTargetEmail } from "$lib/chat/server/db/ipHash";

export type TargetEmailRateKind = "otp" | "invite" | "newDevice";

function typeFor(kind: TargetEmailRateKind): string {
	return `targetEmail:${kind}`;
}

const OTP_SOURCE_TYPE = "otpSourceRate";
// A single source may account for at most this many of a target's overall OTP_RATE_MAX (betterAuth.ts)
// — strictly less than that cap, so exhausting one victim's whole budget requires at least two
// distinct sources. Exported so a test can assert this stays strictly below betterAuth.ts's own
// OTP_RATE_MAX rather than trusting the two comments (in different files) to stay in sync by hand.
export const OTP_SOURCE_MAX = 2;

/**
 * targetEmailSendAllowed above (CUR-920) stops a cap-BYPASS (fanning across serverless
 * instances), but once it's reliable it ALSO makes a targeted lockout DoS reliable — a handful of
 * automated requests from one source burns a specific victim's whole OTP quota and denies them email
 * sign-in. OTP requests are unauthenticated, so unlike sendWorkspaceInvitationEmail's own per-inviter
 * cap there's no real identity to key the source dimension on — the IP is what's available.
 *
 * Deliberately keyed on the (ip, target-email) PAIR, not "sends per IP." A flat per-IP cap would lock
 * out a shared conference/demo network — see hashIp's own "campus NAT, carrier CGNAT" reasoning and
 * rateLimit.ts's identical justification for RATE_LIMIT_IP_MULTIPLIER being a generous, opt-in ceiling
 * rather than a hard per-IP count. A room of a hundred real attendees each requesting their OWN one
 * code never repeats an (ip, target) pair, so this never approaches the cap; only one source hammering
 * the SAME victim does.
 */
export async function otpSourceSendAllowed(
	ip: string | null | undefined,
	email: string
): Promise<boolean> {
	// "otp-source" domain, NOT "rate-limit" — chat/rateLimit.ts also writes ipHash("rate-limit") rows
	// on this same table, but keyed alongside the caller's REAL userId. Reusing that domain here would
	// let anyone with DB read access join an otpSourceRate row to a real user by matching ipHash values
	// (the exact deanonymisation vector db/ipHash.ts's own header explains domain separation prevents).
	const ipHash = hashIp(ip, "otp-source");
	const emailHash = hashTargetEmail(email);
	if (!ipHash || !emailHash) return true; // can't pseudonymize either side → the target-wide cap still applies
	return underEventLimit(
		{ type: OTP_SOURCE_TYPE, ipHash, userId: emailHash },
		OTP_SOURCE_MAX,
		"otp-source-rate"
	);
}

export async function recordOtpSourceSend(
	ip: string | null | undefined,
	email: string,
	windowMs: number
): Promise<void> {
	// "otp-source" domain, NOT "rate-limit" — chat/rateLimit.ts also writes ipHash("rate-limit") rows
	// on this same table, but keyed alongside the caller's REAL userId. Reusing that domain here would
	// let anyone with DB read access join an otpSourceRate row to a real user by matching ipHash values
	// (the exact deanonymisation vector db/ipHash.ts's own header explains domain separation prevents).
	const ipHash = hashIp(ip, "otp-source");
	const emailHash = hashTargetEmail(email);
	if (!ipHash || !emailHash) return;
	await recordEvent(
		{ type: OTP_SOURCE_TYPE, ipHash, userId: emailHash },
		windowMs,
		"otp-source-rate"
	);
}

export async function targetEmailSendAllowed(
	email: string,
	kind: TargetEmailRateKind,
	windowMs: number,
	max: number
): Promise<boolean> {
	const ipHash = hashTargetEmail(email);
	if (!ipHash) return true; // no pepper → can't pseudonymize → can't track (in-memory cap still applies)
	return underEventLimit({ type: typeFor(kind), ipHash }, max, `target-email-rate:${kind}`);
}

export async function recordTargetEmailSend(
	email: string,
	kind: TargetEmailRateKind,
	windowMs: number
): Promise<void> {
	const ipHash = hashTargetEmail(email);
	if (!ipHash) return;
	await recordEvent({ type: typeFor(kind), ipHash }, windowMs, `target-email-rate:${kind}`);
}
