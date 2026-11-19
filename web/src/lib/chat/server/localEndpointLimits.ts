/**
 * abuse bounds on a signed-in account's local inference endpoints. Each direct endpoint is
 * a URL our servers poll; each managed one also makes a site, a resource and an access token in our
 * tunnel org. So an account holds a few of each, managed fewer, and creating or polling one goes
 * through the shared DB-backed limiter (`enforceRequestRateLimits`).
 *
 * The numbers are conservative defaults, not measured limits: a person runs a model on a laptop and
 * perhaps a desktop, rarely more.
 */
import { error } from "@sveltejs/kit";
import { listLocalEndpointsForUserId } from "$lib/chat/server/db/localInferenceEndpoints";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";

/** Lowered from 10 to 5 so that a full account stays under the status-poll limit —
 *  the settings page polls direct and managed servers alike, so the two caps add up against
 *  STATUS_CHECKS_PER_MINUTE below. */
const MAX_DIRECT_ENDPOINTS_PER_ACCOUNT = 5;
/** Exported so the pairing link can name the cap it was refused by. Raised from 3 to 10
 *: repeated CLI install tests filled a 3-server account, and the CLI's logout and
 *  uninstall never remove the server-side endpoint, so the pairing link failed for a reason the
 *  person could not see. The cap still bounds what one account can make in the shared tunnel org. */
export const MAX_MANAGED_ENDPOINTS_PER_ACCOUNT = 10;

/** Creates per account per hour, direct and managed together. */
const CREATES_PER_HOUR = 10;
/** Status checks per account per minute. The settings page polls every server every 10 s, direct
 *  and managed alike, so a full account (5 direct + 10 managed = 15 servers) makes 90 a minute —
 *  three quarters of this limit, leaving headroom for a page reload or a second tab. chose
 *  the two caps above to fit under it: the previous 10 direct + 20 managed (30 servers, 180 a
 *  minute) was over the limit and the status dots would have 429'd. The limit itself is unchanged,
 *  since a higher limit (or a slower poll) is a separate decision from making the cap's refusal
 *  visible. Note that the caps only refuse new creates: an account created may
 *  still hold up to 10 direct servers, which with 10 managed is 120 a minute — at the limit. */
const STATUS_CHECKS_PER_MINUTE = 120;

/** Refuse a create once the account holds the cap for that kind. A row with no `kind` predates
 *  managed endpoints and counts as direct, as it does everywhere else. */
export async function assertUnderEndpointCap(userId: string, kind: "direct" | "managed"): Promise<void> {
	const rows = await listLocalEndpointsForUserId(userId);
	const held = rows.filter((r) => (r.kind === "managed") === (kind === "managed")).length;
	const cap = kind === "managed" ? MAX_MANAGED_ENDPOINTS_PER_ACCOUNT : MAX_DIRECT_ENDPOINTS_PER_ACCOUNT;
	if (held >= cap) {
		error(
			409,
			kind === "managed"
				? `You can pair up to ${cap} managed servers. Remove one in Settings to pair another.`
				: `You can add up to ${cap} servers. Remove one in Settings to add another.`
		);
	}
}

export function limitEndpointCreate(userId: string, clientAddress: string): Promise<void> {
	return enforceRequestRateLimits({
		userId,
		clientAddress,
		event: "localEndpointCreate",
		perSession: { limit: CREATES_PER_HOUR, windowMs: 60 * 60_000 },
	});
}

export function limitEndpointStatus(userId: string, clientAddress: string): Promise<void> {
	return enforceRequestRateLimits({
		userId,
		clientAddress,
		event: "localEndpointStatus",
		perSession: { limit: STATUS_CHECKS_PER_MINUTE, windowMs: 60_000 },
	});
}
