// Brute-force lockout for the admin CLI-token check (validate-token/+server.ts). ADMIN_CLI_LOGIN stays
// `false` in production, so this is defense in depth for a deployment that turns it on. IP-hash-keyed
// rows counted through eventWindow.ts, failing open.
import { config } from "$lib/chat/server/config";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { clearEvents, recordEvent, underEventLimit, type EventKey } from "$lib/chat/server/db/eventWindow";

const TYPE = "adminTokenFail";
const LABEL = "admin-token";

function maxFails(): number {
	return Number(Reflect.get(config, "ADMIN_TOKEN_MAX_FAILS")) || 5;
}
function windowMs(): number {
	const mins = Number(Reflect.get(config, "ADMIN_TOKEN_WINDOW_MIN")) || 15;
	return mins * 60_000;
}

// No pepper or no IP means the IP can't be hashed, so the throttle does nothing (fail open).
function keyFor(ip: string | null | undefined): EventKey | null {
	const ipHash = hashIp(ip, "admin-audit");
	return ipHash ? { type: TYPE, ipHash } : null;
}

/** True if this IP is under the recent-failure limit (allowed to attempt). Fail-open on any error. */
export async function adminTokenAllowed(ip: string | null | undefined): Promise<boolean> {
	const key = keyFor(ip);
	return key ? underEventLimit(key, maxFails(), LABEL) : true;
}

/** Record one failure for this IP (TTL = the lockout window). Best-effort. */
export async function recordAdminTokenFailure(ip: string | null | undefined): Promise<void> {
	const key = keyFor(ip);
	if (key) await recordEvent(key, windowMs(), LABEL);
}

/** Clear this IP's recorded failures after a success. Best-effort. */
export async function clearAdminTokenFailures(ip: string | null | undefined): Promise<void> {
	const key = keyFor(ip);
	if (key) await clearEvents(key, LABEL);
}
