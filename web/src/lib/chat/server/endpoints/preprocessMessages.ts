// preprocessMessages — endpoint-side consumer of the ONE shared media pass. Hydrating and
// clipboard-expanding here, downstream of the safety gate, would be an unscreened path, so
// prepareTurnMedia owns hydrate/decode/splice/clipboard ONCE, and this function only projects its
// per-message structure onto the endpoint shape:
//
//   user messages    → content = finalText (documents + clipboard + typed, budget-capped);
//                      files = the retained image occurrences as base64 SOURCE bytes (the
//                      endpoint's own imageProcessor consumes these), named by sha.
//   non-user messages → passed through UNCHANGED, without hydration. Their files are never read
//                      downstream: prepareMessagesWithFiles formats files only for from === "user",
//                      and endpointAgent builds its prompt from {from, content} alone (verified by
//                      grep over prepareFiles.ts / endpointOai.ts / agent/ — nothing else touches
//                      EndpointMessage.files).
//
// The route passes the turn's already-settled PreparedTurnMedia; when absent (tests, non-route
// callers) it is computed here — ONE implementation either way, never a duplicated hydrate path.

import type { Message } from "$lib/chat/types/Message";
import type { EndpointMessage } from "./types";
import type { ObjectId } from "bson";
import {
	prepareTurnMedia,
	type PreparedTurnMedia,
} from "$lib/chat/server/chat/prepareTurnMedia";

export async function preprocessMessages(
	messages: Message[],
	convId: ObjectId,
	media?: PreparedTurnMedia,
	ownerId?: string
): Promise<EndpointMessage[]> {
	const prepared = media ?? (await prepareTurnMedia(messages, convId, { ownerId }));

	const projected = messages.map<EndpointMessage>((message) => {
		const entry = message.from === "user" ? prepared.messages.get(message.id) : undefined;
		if (!entry) return { ...message };
		return {
			...message,
			content: entry.finalText,
			...(entry.attachedText ? { attachedText: entry.attachedText } : {}),
			files: entry.images.map((img) => ({
				type: "base64" as const,
				value: img.source.toString("base64"),
				mime: img.mime,
				name: img.sha,
			})),
		};
	});

	return stripEmptyInitialSystemMessage(projected);
}

/**
 * Remove an initial system message if its content is empty/whitespace only.
 * This prevents sending an empty system prompt to any provider.
 */
function stripEmptyInitialSystemMessage(messages: EndpointMessage[]): EndpointMessage[] {
	if (!messages?.length) return messages;
	const first = messages[0];
	if (first?.from !== "system") return messages;

	const content = first?.content as unknown;
	const isEmpty = typeof content === "string" ? content.trim().length === 0 : false;

	if (isEmpty) {
		return messages.slice(1);
	}

	return messages;
}
