// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { error, type RequestHandler } from "@sveltejs/kit";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { authCondition } from "$lib/chat/server/auth";
import { ObjectId } from "bson";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	const messageId = params.messageId ?? "";

	const conversation = await resolveConversation(id, locals);

	if (!conversation.messages.map((m) => m.id).includes(messageId)) {
		error(404, "Message not found");
	}

	// Taken before the filter below edits messages in place.
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

	const res = await saveConversationMessages({ _id: new ObjectId(conversation._id), ...authCondition(locals) }, loaded, {
		messages: filteredMessages,
	});

	if (res.modifiedCount === 0) {
		error(500, "Deleting message failed");
	}

	return superjsonResponse({ success: true });
};
