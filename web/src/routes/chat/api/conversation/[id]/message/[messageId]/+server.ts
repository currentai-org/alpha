import { authCondition } from "$lib/chat/server/auth";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { collections } from "$lib/chat/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { syncBump, tombstoneMessages } from "$lib/chat/server/sync/syncTouch";

export async function DELETE({ locals, params }) {
	const messageId = params.messageId;

	if (!messageId || typeof messageId !== "string") {
		error(400, "Invalid message id");
	}

	const conversation = await collections.conversations.findOne({
		...authCondition(locals),
		_id: new ObjectId(params.id),
	});

	if (!conversation) {
		error(404, "Conversation not found");
	}

	// Taken before the filter below edits messages in place. (CUR-2806)
	const loaded = snapshotConversation(conversation);
	const filteredMessages = conversation.messages
		.filter(
			(message) =>
				// not the message AND the message is not in ancestors
				!(message.id === messageId) && message.ancestors && !message.ancestors.includes(messageId)
		)
		.map((message) => {
			// remove the message from children if it's there
			if (message.children && message.children.includes(messageId)) {
				message.children = message.children.filter((child) => child !== messageId);
			}
			return message;
		});

	const before = [...conversation.messages];
	await saveConversationMessages({ _id: conversation._id, ...authCondition(locals) }, loaded, {
		messages: filteredMessages,
		...syncBump(locals),
	});
	await tombstoneMessages(locals, before, filteredMessages);

	return new Response();
}
