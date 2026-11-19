// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { authCondition } from "$lib/chat/server/auth";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { collections } from "$lib/chat/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";

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

	// Taken before the filter below edits messages in place.
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

	await saveConversationMessages({ _id: conversation._id, ...authCondition(locals) }, loaded, {
		messages: filteredMessages,
	});

	return new Response();
}
