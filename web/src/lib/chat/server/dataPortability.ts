import { error } from "@sveltejs/kit";
import type { MessageEvent } from "$lib/chat/types/MessageEvent";
import { flagEnabledOr } from "$lib/chat/server/flags";

// Taking a copy of a user's own data out.
// Any signed-in user may export their own data (that change removed the earlier admin-only gate; the
// `data-export` flag that gated it, was retired once it was on everywhere). Rate-limited to
// one export an hour, see nextExportAt.

export type ExportEventType = Extract<MessageEvent["type"], "export" | "export-thunderbolt" | "export-open-webui">;

/**
 * When this account may export again, or null when it may export now. One export per hour: the
 * route writes a `messageEvents` row of type "export" that expires an hour later, and an unexpired
 * row is what refuses the next one. Shared by the route (which answers 429) and the account page
 * (which says so inline instead of linking to a bare error page).
 */
export async function nextExportAt(
	userId: unknown,
	now = new Date(),
	type: ExportEventType = "export"
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
	return user;
}

/** PostHog flag key. Owner: chat. The Thunderbolt download beside the ZIP. */
export const THUNDERBOLT_EXPORT_FLAG = "thunderbolt-export";

/**
 * May this request download its conversations as a file Thunderbird's Thunderbolt imports?
 */
export function thunderboltExportEnabled(): boolean {
	return flagEnabledOr(THUNDERBOLT_EXPORT_FLAG, () => false);
}

