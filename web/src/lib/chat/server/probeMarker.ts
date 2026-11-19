// Which production probe sent this turn, if any.
//
// The scheduled probes (synthetic-turn, alpha-demo-probe, chat-trajectory-probe) send real turns to
// production, and a turn a screen declines writes a `safety_events` row like any visitor's. Their rows
// carry the probe's name in `safety_events.probe`, so a count of real declines can leave them out.
//
// The marker must be verified: a visitor who could set it would hide their own decline from every count.
// So it counts only when `x-probe-token` matches PROBE_MARKER_TOKEN (constant-time, over HMAC digests of
// equal length, as cronAuth.ts compares its bearer). Unset token, absent header or wrong value all
// return null, and the row is written unmarked, as before. Unlike the e2e fault headers this works in
// production, which is where the probes run.

import { config } from "$lib/chat/server/config";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";

// HMAC label for the compare below; domain separation, not a secret.
const PROBE_MARKER_HASH_LABEL = "probe-marker-v1";
const PROBE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The verified probe's name (`x-probe-name`, or "probe" when that is absent or malformed), or null
 *  when the request carries no valid probe token. Never throws. */
export async function resolveProbeMarker(req: Request): Promise<string | null> {
	const supplied = req.headers.get("x-probe-token");
	if (!supplied) return null;
	const secret = config.PROBE_MARKER_TOKEN;
	if (!secret) return null;
	const [got, want] = await Promise.all([
		hmacSha256(PROBE_MARKER_HASH_LABEL, supplied),
		hmacSha256(PROBE_MARKER_HASH_LABEL, secret),
	]);
	if (!timingSafeEqual(got, want)) return null;
	const name = (req.headers.get("x-probe-name") ?? "").trim().toLowerCase();
	return PROBE_NAME.test(name) ? name : "probe";
}
