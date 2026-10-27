/**
 * The caps in targetEmailRate.ts are keyed on one address or one (IP, address) pair, so a
 * signed-out script that rotates addresses meets no ceiling before the email provider's own, and every
 * address it names gets an unwanted email. Two caps close that:
 *
 *   - a site-wide daily ceiling on codes to addresses with no account yet. It is a circuit breaker:
 *     real sign-ups stay far below it, so it is reached only by a script. Codes to an
 *     existing account count outside it, so a script spending it locks out new sign-ups for the rest of
 *     the day and nobody who already has an account.
 *   - a per-address daily cap on addresses with no account, so a stranger's inbox gets at most a
 *     handful of codes a day however the requests are spread. A member's address is exempt: a daily cap
 *     there would let anyone who knows it lock them out of sign-in for 24 hours.
 *
 * Counted through eventWindow.ts on the message_events table, like every other cap there. The address is
 * stored only as its peppered hash (hashTargetEmail). FAIL OPEN, the same posture as those caps: a DB
 * blip must never stop a real person signing in. (CUR-4172)
 */
import { config } from "$lib/chat/server/config";
import { getDb } from "$lib/chat/server/db/client";
import { recordEvent, underEventLimit } from "$lib/chat/server/db/eventWindow";
import { hashTargetEmail } from "$lib/chat/server/db/ipHash";
import { user } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";
import { eq } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60_000;
const SITE_TYPE = "signInCodeSiteNew";
const SITE_KEY = "site";
const ADDRESS_TYPE = "signInCodeAddressDay";

// Optional deploy knobs (read via Reflect.get so they need no committed .env entry).
function maxNewAddressCodesPerDay(): number {
	return Number(Reflect.get(config, "OTP_SITE_NEW_MAX_PER_DAY")) || 1000;
}

function maxCodesPerAddressPerDay(): number {
	return Number(Reflect.get(config, "OTP_ADDRESS_MAX_PER_DAY")) || 10;
}

/** True when an account already uses this address. Better Auth stores emails lowercased, so an exact
 * match on the lowered address uses the unique index. A failed lookup reads as false, the stricter side. */
export async function accountExistsForEmail(email: string): Promise<boolean> {
	try {
		const rows = await getDb()
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email.trim().toLowerCase()))
			.limit(1);
		return rows.length > 0;
	} catch (e) {
		logger.warn({ err: String(e) }, "[auth] account lookup for the sign-in code ceiling failed");
		return false;
	}
}

/** True while the site is under its daily ceiling on codes to addresses with no account. */
export async function newAddressCodeAllowed(): Promise<boolean> {
	return underEventLimit({ type: SITE_TYPE, userId: SITE_KEY }, maxNewAddressCodesPerDay(), "otp-site-new");
}

export async function recordNewAddressCode(): Promise<void> {
	await recordEvent({ type: SITE_TYPE, userId: SITE_KEY }, DAY_MS, "otp-site-new");
}

/** True while this address has had fewer than its daily allowance of codes. */
export async function addressCodeAllowedToday(email: string): Promise<boolean> {
	const emailHash = hashTargetEmail(email);
	if (!emailHash) return true; // no pepper: the 10-minute caps still apply
	return underEventLimit({ type: ADDRESS_TYPE, ipHash: emailHash }, maxCodesPerAddressPerDay(), "otp-address-day");
}

export async function recordAddressCode(email: string): Promise<void> {
	const emailHash = hashTargetEmail(email);
	if (!emailHash) return;
	await recordEvent({ type: ADDRESS_TYPE, ipHash: emailHash }, DAY_MS, "otp-address-day");
}
