import { collections } from "$lib/chat/server/database";
import { ObjectId } from "bson";
import { authCondition } from "$lib/chat/server/auth";
import { convertLegacyConversation } from "$lib/chat/utils/tree/convertLegacyConversation";
import { error } from "@sveltejs/kit";
import { logger } from "$lib/chat/server/logger";

/**
 * Resolve an owned conversation by ObjectId, with an auth check.
 * (Shared-conversation lookups removed in the B1-lite strip.)
 *
 * Returns the conversation with legacy fields converted.
 */
export async function resolveConversation(id: string, locals: App.Locals) {
	try {
		new ObjectId(id);
	} catch {
		error(400, "Invalid conversation ID format");
	}

	const conversation = await collections.conversations.findOne({
		_id: new ObjectId(id),
		...authCondition(locals),
	});

	if (!conversation) {
		// findOne rather than a countDocuments existence check (CUR-1315), so a denial (below) can log the
		// ACTUAL identity mismatch, not just "cookie was present". Without the owner's sessionId, a 403 after a
		// 200 on the same resource from the same apparent client cannot be told apart as a cookie-value
		// change or a read consistency issue.
		// sessionId is already a one-way sha256 hash stored in plaintext on every conversation row
		// (never the raw secret cookie), so logging it here exposes nothing the DB doesn't already.
		const owner = await collections.conversations.findOne({ _id: new ObjectId(id) });

		if (owner) {
			logger.warn(
				{
					conversationId: id,
					requesterSessionId: locals.sessionId,
					requesterUserId: locals.user?._id?.toString(),
					ownerSessionId: owner.sessionId,
					ownerUserId: owner.userId?.toString(),
				},
				"[auth][CUR-1315] resolveConversation denied — owner identity did not match the requester"
			);
		}

		// The same 404 either way. A 403 here told any caller which ids belong to someone. (CUR-3523)
		error(404, "Conversation not found.");
	}

	return {
		...conversation,
		...convertLegacyConversation(conversation),
		shared: false,
	};
}
