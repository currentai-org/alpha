import { error, type RequestHandler } from "@sveltejs/kit";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { authCondition } from "$lib/chat/server/auth";
import { ObjectId } from "bson";
import { syncBump, tombstoneMessages } from "$lib/chat/server/sync/syncTouch";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	const messageId = params.messageId ?? "";

	const conversation = await resolveConversation(id, locals);

	if (!conversation.messages.map((m) => m.id).includes(messageId)) {
		error(404, "Message not found");
	}

	// Taken before the filter below edits messages in place. (CUR-2806)
	const loaded = snapshotConversation(conversation);
	const filteredMessages = conversation.messages
		.filter(
			(message) =>
				!(message.id === messageId) && message.ancestors && !message.ancestors.includes(messageId)
		)
		.map((message) => {
			if (message.children && message.children.includes(messageId)) {
				message.children = message.children.filter((child) => child !== messageId);
			}
			return message;
		});

	const before = [...conversation.messages];
	const res = await saveConversationMessages({ _id: new ObjectId(conversation._id), ...authCondition(locals) }, loaded, {
		messages: filteredMessages,
		...syncBump(locals),
	});

	if (res.modifiedCount === 0) {
		error(500, "Deleting message failed");
	}
	await tombstoneMessages(locals, before, filteredMessages);

	return superjsonResponse({ success: true });
};
