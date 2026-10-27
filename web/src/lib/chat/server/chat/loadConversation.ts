import { error } from "@sveltejs/kit";
import type { ObjectId } from "bson";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { convertLegacyConversation } from "$lib/chat/utils/tree/convertLegacyConversation";
import type { Conversation } from "$lib/chat/types/Conversation";

/**
 * Load the conversation a chat turn writes into, authorize the caller against it, and lazily
 * migrate a legacy (pre-message-tree) conversation to the rootMessageId shape.
 *
 * Throws (SvelteKit `error`) on the same unhappy paths the POST handler enforced inline:
 *   - 404 — conversation not found or not owned by the caller (auth-scoped query)
 *   - 500 — legacy → tree conversion failed to persist
 *
 * The auth-scoped `findOne` runs twice by design: once to detect a legacy doc to migrate, then
 * again after migration so the returned conversation always carries the tree shape. Model
 * resolution is left to the caller, which orders it after the per-turn rate/usage guards.
 */
export async function loadAuthorizedConversation(opts: {
	convId: ObjectId;
	locals: App.Locals;
}): Promise<Conversation> {
	const { convId, locals } = opts;

	// check if the user has access to the conversation
	const convBeforeCheck = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (convBeforeCheck && !convBeforeCheck.rootMessageId) {
		const res = await collections.conversations.updateOne(
			{ _id: convId },
			{
				$set: {
					...convBeforeCheck,
					...convertLegacyConversation(convBeforeCheck),
				},
			}
		);

		if (!res.acknowledged) {
			error(500, "Failed to convert conversation");
		}
	}

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	return conv;
}
