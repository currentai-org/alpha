import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger";
import { moveGuestFilesToUser } from "$lib/chat/server/storage/custodialStorage";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { DEFAULT_SETTINGS } from "$lib/chat/types/Settings";
import type { User } from "$lib/chat/types/User";

// Every login path that mints a new identity for a previously-anonymous session needs
// the same re-keying, not a second hand-rolled copy of it. (CUR-849)

/**
 * Re-key an anonymous session's conversations onto the user signing in. Safe on every login, not
 * only the first: a returning user signing in from a browser that was anonymous first should still
 * pick up that browser's conversations. Idempotent — once re-keyed, `userId` is set and a repeat
 * call's query matches nothing.
 */
export async function migrateAnonymousConversations(
	previousSessionId: string | undefined,
	userId: User["_id"],
	opts: { skipFileMove?: boolean } = {}
): Promise<void> {
	if (!previousSessionId) {
		return;
	}
	const { matchedCount } = await collections.conversations.updateMany(
		{ sessionId: previousSessionId },
		{ $set: { userId, formerGuestSessionId: previousSessionId }, $unset: { sessionId: "" } }
	);
	// The session's attachments follow its conversations to the account. This is the one
	// place both ids are in hand, since the update above clears the session from every conversation.
	// In the background, because a bucket copy should not hold up sign-in; until it lands, and for any
	// file it leaves behind, a turn reads the guest copy through formerGuestSessionId.
	// `skipFileMove` is the `guest_file_move_skipped` fault (preview only), which leaves every file
	// under guests/ the way a failed or over-quota move does, so a spec can delete what remains (CUR-3292). (CUR-2183)
	// auth.ts calls this on every request a returning signed-in visitor makes, and the move
	// lists guests/<session>/ on Hugging Face before it can find nothing there, which spent one call of
	// the shared storage token per page load, poll and API call. A guest's files sit under its
	// conversations, so when none was re-keyed there is nothing to move. (CUR-3682)
	if (opts.skipFileMove || !matchedCount) return;
	void runInBackground(
		moveGuestFilesToUser(previousSessionId, userId.toString()).then((r) => {
			if (r && (r.moved || r.failed)) logger.info(r, "[storage] guest attachments moved to the account");
			if (r?.failed) logger.warn(r, "[storage] some guest attachments did not move; they stay under guests/ until the sweep");
			if (r?.overQuota) logger.warn(r, "[storage] guest attachments over the account quota stay under guests/ until the sweep");
		})
	);
}

/**
 * Re-key an anonymous session's settings onto a BRAND NEW user, or seed defaults if none exist.
 * First-login/new-user creation only — an existing user already has their own settings, so calling
 * this for a returning user would stomp them with whatever this browser's anonymous prefs happen
 * to be.
 */
export async function migrateAnonymousSettings(
	previousSessionId: string | undefined,
	userId: User["_id"]
): Promise<void> {
	const { matchedCount } = previousSessionId
		? await collections.settings.updateOne(
				{ sessionId: previousSessionId },
				{ $set: { userId, updatedAt: new Date() }, $unset: { sessionId: "" } }
			)
		: { matchedCount: 0 };

	if (!matchedCount) {
		try {
			await collections.settings.insertOne({
				userId,
				updatedAt: new Date(),
				createdAt: new Date(),
				...DEFAULT_SETTINGS,
			});
		} catch (err) {
			// Two requests carrying a new user's first session both reach here, and the second
			// insert hits settings_user_idx. A row for this user now existing means the other request
			// seeded it, which is the outcome this call wanted; anything else is a real failure. (CUR-2607)
			if (!(await collections.settings.findOne({ userId }))) throw err;
		}
	}
}
