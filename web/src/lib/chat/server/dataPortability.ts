import { error } from "@sveltejs/kit";
import { flagEnabledOr } from "$lib/chat/server/flags";

// Taking a copy of a user's own data out.
//
// ── What stays in env ─────────────────────────────────────────────────────────────────────────────
// The flag decides on/off, not an `ENABLE_DATA_EXPORT` env boolean: env cannot roll out to a fraction
// of traffic and cannot be turned off without a redeploy. Env keeps whatever the feature needs in
// order to run, which for this one is nothing.
//
// ── Cold start fails closed (CUR-891) ───────────────────────────────────────────────────────────
// `flagEnabledOr` (flags.ts) keeps serving the last-known PostHog value forever once it has polled
// successfully even once, so the fallback only matters for the narrow cold-start window: a fresh
// process, or local dev with no PostHog key. For that window, failing closed is the safer
// default: this gates a capability, not a presence-check paired to config that has to exist for the
// feature to run at all (contrast `accounts`, which mirrors whether an OIDC client id is configured).

/** PostHog flag key. Owner: chat. */
export const DATA_EXPORT_FLAG = "data-export";

/**
 * May this request export its own data? Server-side gate on the export endpoint.
 *
 * Any signed-in user may export their own data once this flag is on (CUR-995). Rate-limited to one
 * export/hour, see the route.
 */
export function dataExportEnabled(): boolean {
	return flagEnabledOr(DATA_EXPORT_FLAG, () => false);
}

/**
 * When this account may export again, or null when it may export now. One export per hour: the
 * route writes a `messageEvents` row of type "export" that expires an hour later, and an unexpired
 * row is what refuses the next one. Shared by the route (which answers 429) and the account page
 * (which says so inline instead of linking to a bare error page).
 */
export async function nextExportAt(
	userId: unknown,
	now = new Date(),
	type: "export" | "export-thunderbolt" = "export"
): Promise<Date | null> {
	const { collections } = await import("$lib/chat/server/database");
	const events = await collections.messageEvents
		.find({ userId, type, expiresAt: { $gt: now } })
		.toArray();
	let latest: Date | null = null;
	for (const e of events) {
		const at = e.expiresAt ? new Date(e.expiresAt) : null;
		if (at && (!latest || at > latest)) latest = at;
	}
	return latest;
}

/**
 * The signed-in user an export route may act for, or the 401/403 that refuses it. Shared by the
 * export itself and its summary, so the two cannot drift on who may read what.
 */
export function requireExportUser<U>(user: U | undefined | null): U {
	if (!user) error(401, "Not logged in");
	if (!dataExportEnabled()) error(403, "Data export is not enabled");
	return user;
}

/** PostHog flag key. Owner: chat. The Thunderbolt download beside the ZIP (CUR-2407). */
export const THUNDERBOLT_EXPORT_FLAG = "thunderbolt-export";

/**
 * May this request download its conversations as a file Thunderbird's Thunderbolt imports? Rides on
 * top of data-export: a person who may not export may not export in another format either.
 */
export function thunderboltExportEnabled(): boolean {
	return dataExportEnabled() && flagEnabledOr(THUNDERBOLT_EXPORT_FLAG, () => false);
}

/** PostHog flag key. Owner: chat. Live two-way sync with the Thunderbolt sandbox (CUR-4312). */
export const THUNDERBOLT_SYNC_FLAG = "thunderbolt-sync";

/**
 * May this account connect Thunderbolt and sync conversations both ways? Gates the OAuth consent and
 * Connections pages, every /chat/api/v2/sync/* route (a 404 when off), and the tombstones and
 * updatedAt bumps the sync reads. Reads the request's account flags, so a sync token's request is evaluated for the
 * account that granted it. Off when PostHog is unreachable.
 */
export function thunderboltSyncEnabled(): boolean {
	return flagEnabledOr(THUNDERBOLT_SYNC_FLAG, () => false);
}
