// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
// The prompt behind one answer: the conversation up to that message, rendered with the model's own
// template. A sealed conversation is one the server cannot open, so its prompt is rebuilt
// from what the owner's browser opened and posts (POST), each body checked against the MAC stored with
// it, as a turn's history is. A GET on a sealed conversation is refused rather than answered with a
// prompt built from empty skeletons.
import { buildPrompt } from "$lib/chat/buildPrompt";
import { effectivePreprompt, resolveTurnPreferences } from "$lib/chat/server/textGeneration/turnPreferences";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { defaultModel } from "$lib/chat/server/models";
import { resolveConversationModel } from "$lib/chat/server/conversationModel";
import { getEffectiveModels } from "$lib/chat/server/localModels";
import { hydratePostedHistory } from "$lib/chat/server/chat/sealedTurn";
import { hasSealedFields } from "$lib/chat/crypto/sealedShape";
import type { Conversation } from "$lib/chat/types/Conversation";
import { buildSubtree } from "$lib/chat/utils/tree/buildSubtree";
import { isMessageId } from "$lib/chat/utils/tree/isMessageId";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";

/** The reason a GET on a sealed conversation is refused; the browser posts the opened history instead. */
const SEALED_PROMPT_REASON = "sealed";

async function loadConversation(params: { id: string; messageId: string }, locals: App.Locals): Promise<Conversation> {
	const conv = await collections.conversations.findOne({
		_id: new ObjectId(params.id),
		...authCondition(locals),
	});
	if (conv === null) error(404, "Conversation not found");
	const messageId = params.messageId;
	if (!isMessageId(messageId) || !conv.messages.some((msg) => msg.id === messageId)) {
		error(404, "Message not found");
	}
	return conv;
}

async function promptResponse(conv: Conversation, messageId: string, locals: App.Locals): Promise<Response> {
	// Same widening as the turn path: a conversation created before an allowlist change names an id the
	// registry no longer has, and this debug view should show the prompt it WOULD send rather than 404.
	// See conversationModel.ts.
	const effectiveModels = await getEffectiveModels(locals);
	const { model } = resolveConversationModel(effectiveModels, defaultModel, conv.model);

	const messagesUpTo = buildSubtree(conv, messageId);
	// A message still sealed here was never opened, so a prompt built from it would be missing its words.
	if (messagesUpTo.some((m) => m.sealed)) {
		error(409, { message: "Part of this chat is sealed and was not opened, so its prompt can't be rebuilt.", reason: SEALED_PROMPT_REASON });
	}

	const prompt = await buildPrompt({
		preprompt: effectivePreprompt(conv.preprompt, await resolveTurnPreferences(locals)),
		messages: messagesUpTo,
		model,
	}).catch((err) => {
		console.error(err);
		return "Prompt generation failed";
	});

	return Response.json(
		{
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
		},
		{ headers: { "cache-control": "no-store" } }
	);
}

export async function GET({ params, locals }) {
	const conv = await loadConversation(params, locals);
	if (hasSealedFields(conv)) {
		error(409, {
			message: "This chat is sealed with your history key. Its prompt is rebuilt from what your browser opens.",
			reason: SEALED_PROMPT_REASON,
		});
	}
	return promptResponse(conv, params.messageId, locals);
}

/** The prompt of a sealed conversation, from the history the owner's browser opened and posts. */
export async function POST({ params, locals, request }) {
	const conv = await loadConversation(params, locals);
	let body: { history?: unknown; preprompt?: unknown };
	try {
		body = await request.json();
	} catch {
		error(400, "invalid JSON body");
	}
	hydratePostedHistory(conv, params.id, body, "[prompt]");
	return promptResponse(conv, params.messageId, locals);
}
