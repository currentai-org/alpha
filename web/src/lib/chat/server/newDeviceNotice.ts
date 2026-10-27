// A sign-in from a device the account has not used before sends the account an email naming
// the device and linking to Active sessions, so someone who did not sign in can see it and end the
// session.
// (CUR-4181)
// A device is a browser, recognised by a random token in a signed, long-lived cookie set at
// sign-in (OWASP's remembered-device cookie), and only while the email is on for the account, since the
// cookie serves nothing else. The browser and system describePlatform reads from the
// user agent ("Chrome on macOS") only names the device in the email: as a key it would let a stranger on the
// owner's browser and system sign in unannounced. A cleared cookie or a private window reads as new, which
// is the trade for that.
//
// Known devices are message_events rows of type `knownBrowser`, keyed on the real user id with a hash of
// the token in `ipHash` (never the token itself), each kept for KNOWN_DEVICE_MS after its last sign-in.
// An account with none on record (a new account) records the
// device and sends nothing.
//
// Everything here runs after the session exists and never throws: a failed read, a refused quota or a
// Resend error is logged, and the sign-in it follows is never touched. (CUR-4231)
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { base } from "$lib/chat/paths";
import { config } from "$lib/chat/server/config";
import { getDb } from "$lib/chat/server/db/client";
import { user, verification } from "$lib/chat/server/db/schema";
import { clearEvents, countLiveEvents, recordEvent } from "$lib/chat/server/db/eventWindow";
import { recordTargetEmailSend, targetEmailSendAllowed } from "$lib/chat/server/db/targetEmailRate";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { accountFlagValues, flagEnabledOr, fuzzOverrideValue } from "$lib/chat/server/flags";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { logger } from "$lib/chat/server/logger";
import { isReservedTestAddress, sendViaResend } from "$lib/chat/server/resend";
import { describePlatform } from "$lib/chat/utils/describePlatform";

/** PostHog flag key. Owner: chat. Gates the new-device sign-in email. */
export const NEW_DEVICE_NOTICE_FLAG = "new-device-notice";

const KNOWN_DEVICE_TYPE = "knownBrowser";
const KNOWN_DEVICE_MS = 180 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE = "known_device";
const DAY_MS = 24 * 60 * 60 * 1000;
/** At most this many notices a day to one address, so a run of sign-ins cannot flood an inbox. */
const NEW_DEVICE_NOTICE_DAILY_MAX = 5;
/** How long the test-address copy stays readable for an e2e spec. */
const TEST_COPY_MS = 60 * 60 * 1000;
const LABEL = "new-device-notice";

/** The name a device goes by in the email and in the known-device record. */
function deviceLabel(userAgent: string | null | undefined): string {
	return describePlatform(userAgent ?? "") ?? "an unrecognised browser";
}

/** The `verification` identifier a test address's notice is written under, for e2e specs to read. */
function newDeviceNoticeIdentifier(email: string): string {
	return `new-device-notice-${email.toLowerCase()}`;
}

function deviceKey(userId: string, deviceId: string) {
	return { type: KNOWN_DEVICE_TYPE, userId, ipHash: `browser:${deviceId}` };
}

/** The parts of better-auth's endpoint context the device cookie needs. */
export interface DeviceCookieContext {
	getSignedCookie(key: string, secret: string): Promise<string | false | null>;
	setSignedCookie(key: string, value: string, secret: string, options?: object): Promise<string>;
	context: {
		secret: string;
		createAuthCookie(name: string, attributes?: object): { name: string; attributes: object };
	};
}

/**
 * The id of the browser signing in: the hash of the token in its device cookie, minting the token when
 * the browser has none or its signature fails. Sets the cookie on the sign-in response either way, so
 * its lifetime restarts with each sign-in. Only the hash leaves this function.
 */
export async function deviceIdForSignIn(ctx: DeviceCookieContext): Promise<string> {
	const cookie = ctx.context.createAuthCookie(DEVICE_COOKIE, { maxAge: KNOWN_DEVICE_MS / 1000 });
	const held = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
	const token = held || randomBytes(32).toString("base64url");
	await ctx.setSignedCookie(cookie.name, token, ctx.context.secret, cookie.attributes);
	return createHash("sha256").update(token).digest("base64url");
}

/** Records the device as known, restarting its window. Two writes rather than a pile of rows per sign-in. */
async function rememberDevice(userId: string, deviceId: string): Promise<void> {
	await clearEvents(deviceKey(userId, deviceId), LABEL);
	await recordEvent(deviceKey(userId, deviceId), KNOWN_DEVICE_MS, LABEL);
}

/**
 * Whether this sign-in is from a browser the account has used before, recording it either way.
 * Returns "known", "new", or "baseline" when there was nothing to compare against.
 */
async function classifyDevice(userId: string, deviceId: string): Promise<"known" | "new" | "baseline"> {
	const onRecord = await countLiveEvents({ type: KNOWN_DEVICE_TYPE, userId }, LABEL);
	if (onRecord === null) return "baseline"; // can't read the record, so can't tell; never mail on a guess
	const seen = onRecord > 0 ? await countLiveEvents(deviceKey(userId, deviceId), LABEL) : 0;
	await rememberDevice(userId, deviceId);
	if (onRecord === 0) return "baseline";
	return seen ? "known" : "new";
}

function noticeEmail(label: string, at: Date, sessionsUrl: string) {
	const when = at.toUTCString();
	return {
		subject: "New sign-in to your AI Potluck account",
		text:
			`Your AI Potluck account was signed in from ${label} on ${when}.\n\n` +
			`If that was you, there is nothing to do.\n\n` +
			`If it wasn't, open Active sessions and sign that device out, then sign in again yourself:\n${sessionsUrl}\n`,
	};
}

async function deliver(email: string, message: { subject: string; text: string }): Promise<void> {
	if (isReservedTestAddress(email)) {
		// No inbox behind example.org, so the e2e reads the notice from here instead (see otp.ts).
		await getDb()
			.insert(verification)
			.values({
				id: crypto.randomUUID(),
				identifier: newDeviceNoticeIdentifier(email),
				value: JSON.stringify(message),
				expiresAt: new Date(Date.now() + TEST_COPY_MS),
			});
		return;
	}
	if (!config.RESEND_API_KEY) {
		logger.info({ subject: message.subject }, "[new-device-notice] RESEND_API_KEY unset — not sent");
		return;
	}
	const sent = await sendViaResend({ to: email, ...message });
	if (!sent.ok) {
		logger.error({ status: sent.status, body: sent.body }, "[new-device-notice] Resend send failed");
		void captureServerException(new Error(`Resend send failed: ${sent.status}`));
		return;
	}
	logger.info({ resendId: sent.id }, "[new-device-notice] sent via Resend");
}

/**
 * The account to notice for, when the email is on for it; null otherwise, or when the read fails.
 * Called before the device cookie is set, so a browser gets the cookie only while the email it serves is on.
 */
export async function newDeviceNoticeAccount(userId: string): Promise<{ email: string } | null> {
	const started = Date.now();
	try {
		const [account] = await getDb()
			.select({ email: user.email, emailVerified: user.emailVerified })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1);
		if (!account) return null;
		// The request is still the signed-out one, so its own flag answers are a guest's: ask for the
		// account's, after any spec override the request carries.
		const on =
			fuzzOverrideValue(NEW_DEVICE_NOTICE_FLAG) ??
			(await accountFlagValues(userId, flagEmail(account)))?.get(NEW_DEVICE_NOTICE_FLAG) ??
			flagEnabledOr(NEW_DEVICE_NOTICE_FLAG, () => false);
		logger.info({ on, ms: Date.now() - started }, "[new-device-notice] flag read");
		return on ? { email: account.email } : null;
	} catch (err) {
		logger.warn({ err, ms: Date.now() - started }, "[new-device-notice] flag read failed — the sign-in stands");
		return null;
	}
}

/**
 * Called once per new session, for an account newDeviceNoticeAccount returned. Emails it when the
 * session's browser is new to it.
 *
 * @param origin the site the link in the email points at; without one, nothing is sent.
 */
export async function noticeNewDevice({
	userId,
	email,
	deviceId,
	userAgent,
	origin,
}: {
	userId: string;
	email: string;
	/** From deviceIdForSignIn. */
	deviceId: string;
	userAgent: string | null | undefined;
	origin: string | undefined;
}): Promise<void> {
	const started = Date.now();
	try {
		const label = deviceLabel(userAgent);
		const seen = await classifyDevice(userId, deviceId);
		if (seen !== "new") {
			logger.info({ seen, ms: Date.now() - started }, "[new-device-notice] no notice");
			return;
		}
		if (!origin) {
			logger.warn("[new-device-notice] no origin to link Active sessions from — not sent");
			return;
		}
		if (!(await targetEmailSendAllowed(email, "newDevice", DAY_MS, NEW_DEVICE_NOTICE_DAILY_MAX))) {
			logger.info("[new-device-notice] daily cap for this address reached — not sent");
			return;
		}
		await recordTargetEmailSend(email, "newDevice", DAY_MS);
		await deliver(email, noticeEmail(label, new Date(), `${origin}${base}/settings/account`));
		logger.info({ ms: Date.now() - started }, "[new-device-notice] notice delivered");
	} catch (err) {
		logger.warn({ err, ms: Date.now() - started }, "[new-device-notice] failed — the sign-in stands");
	}
}
