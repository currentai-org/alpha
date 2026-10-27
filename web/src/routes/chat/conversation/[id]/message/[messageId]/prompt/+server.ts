import { buildPrompt } from "$lib/chat/buildPrompt";
import { effectivePreprompt, resolveTurnPreferences } from "$lib/chat/server/textGeneration/turnPreferences";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { defaultModel } from "$lib/chat/server/models";
import { resolveConversationModel } from "$lib/chat/server/conversationModel";
import { getEffectiveModels } from "$lib/chat/server/localModels";
import { buildSubtree } from "$lib/chat/utils/tree/buildSubtree";
import { isMessageId } from "$lib/chat/utils/tree/isMessageId";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";

export async function GET({ params, locals }) {
	const conv = await collections.conversations.findOne({
		_id: new ObjectId(params.id),
		...authCondition(locals),
	});

	if (conv === null) {
		error(404, "Conversation not found");
	}

	const messageId = params.messageId;

	const messageIndex = conv.messages.findIndex((msg) => msg.id === messageId);

	if (!isMessageId(messageId) || messageIndex === -1) {
		error(404, "Message not found");
	}

	// Same widening as the turn path: a conversation created before an allowlist change names an id the
	// registry no longer has, and this debug view should show the prompt it WOULD send rather than 404.
	// See conversationModel.ts.
	const effectiveModels = await getEffectiveModels(locals);
	const { model } = resolveConversationModel(effectiveModels, defaultModel, conv.model);

	const messagesUpTo = buildSubtree(conv, messageId);

	const prompt = await buildPrompt({
		preprompt: effectivePreprompt(conv.preprompt, await resolveTurnPreferences(locals)),
		messages: messagesUpTo,
		model,
	}).catch((err) => {
		console.error(err);
		return "Prompt generation failed";
	});

	return Response.json({
		prompt,
		model: model.name,
		parameters: {
			...model.parameters,
			return_full_text: false,
		},
		messages: messagesUpTo.map((msg) => ({
			role: msg.from,
			content: msg.content,
			createdAt: msg.createdAt,
			updatedAt: msg.updatedAt,
			updates: msg.updates?.filter((u) => u.type === "title"),
			files: msg.files,
		})),
	});
}
