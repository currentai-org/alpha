// What a request outside the turn posts so the server can read a sealed conversation: the
// conversation as stored now, opened in this tab, so each body is at the revision the server holds.
// The age cipher loads only for a conversation that has something sealed.

import { useAPIClient, handleResponse } from "$lib/chat/APIClient";
import { hasSealedFields, showsClosedSealedParts, type SealableConversation } from "$lib/chat/crypto/sealedShape";

type OpenedEntry = { id: string; rev: number; body: Record<string, unknown>; salt?: string };

/** The opened sealed messages and preprompt of a conversation, in the turn's post shape; empty when
 *  nothing in it is sealed, and missing whatever this tab could not open (locked). */
export async function sealedHistoryForRequest(
	conversationId: string,
	identity: string | null
): Promise<{ history?: OpenedEntry[]; preprompt?: { rev: number; text: string; salt?: string } }> {
	const doc = (await useAPIClient()
		.conversations({ id: conversationId })
		.get()
		.then(handleResponse)) as SealableConversation;
	if (!hasSealedFields(doc)) return {};
	const { reopenForTurn } = await import("$lib/chat/crypto/sealedHistory");
	const { history, sealedPreprompt } = await reopenForTurn(doc, conversationId, identity);
	return { ...(history ? { history } : {}), ...(sealedPreprompt ? { preprompt: sealedPreprompt } : {}) };
}

/** Does this conversation, as stored now, have anything sealed? Reads the doc; loads no cipher. */
export async function conversationIsSealed(conversationId: string): Promise<boolean> {
	const doc = (await useAPIClient()
		.conversations({ id: conversationId })
		.get()
		.then(handleResponse)) as SealableConversation;
	return hasSealedFields(doc);
}

/** Why a sealed conversation could not be released: this browser has not unlocked, or a part of it
 *  does not open. */
export class SealedReleaseError extends Error {
	override name = "SealedReleaseError";
	constructor(readonly reason: "locked" | "unreadable") {
		super(
			reason === "locked"
				? "This chat is sealed with your history key. Unlock your history in this browser to share it."
				: "Part of this chat could not be opened with this browser's key, so it was not shared."
		);
	}
}

/**
 * What sharing a sealed conversation posts: every sealed body and the preprompt, opened here
 * at the revision the server holds so it can check each against its MAC, and the opened title. Empty
 * when nothing is sealed. Throws `SealedReleaseError` rather than releasing a chat with parts missing.
 */
export async function sealedReleaseForShare(
	conversationId: string,
	identity: string | null
): Promise<{ history?: OpenedEntry[]; preprompt?: { rev: number; text: string; salt?: string }; title?: string }> {
	const doc = (await useAPIClient()
		.conversations({ id: conversationId })
		.get()
		.then(handleResponse)) as SealableConversation;
	if (!hasSealedFields(doc)) return {};
	if (!identity) throw new SealedReleaseError("locked");
	const [{ openConversationDoc }, { sealedHistoryForTurn }] = await Promise.all([
		import("$lib/chat/crypto/sealedHistory"),
		import("$lib/chat/crypto/openedHistory"),
	]);
	const view = await openConversationDoc(doc, conversationId, identity);
	if (showsClosedSealedParts(view)) throw new SealedReleaseError("unreadable");
	const { history, sealedPreprompt } = sealedHistoryForTurn(
		conversationId,
		doc.messages.map((m) => m.id)
	);
	return {
		...(history ? { history } : {}),
		...(sealedPreprompt ? { preprompt: sealedPreprompt } : {}),
		...(doc.sealedTitle ? { title: view.title ?? "" } : {}),
	};
}
