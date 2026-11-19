// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { useAPIClient, handleResponse, ApiError } from "$lib/chat/APIClient";
import { UrlDependency } from "$lib/chat/types/UrlDependency";
import { error as kitError, redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { base } from "$lib/chat/paths";
import { ERROR_MESSAGES, error } from "$lib/chat/stores/errors";
import type { PageLoad } from "./$types";
import type { Message } from "$lib/chat/types/Message";
import { hasSealedFields, type SealedState } from "$lib/chat/crypto/sealedShape";
import { historyKeyring } from "$lib/chat/crypto/historyKeyring.svelte";

interface ConversationData {
	messages: Message[];
	title: string;
	model: string;
	preprompt?: string;
	/** Sealed title and preprompt; opened below and never handed to the page. */
	sealedTitle?: string;
	sealedTitleRev?: number;
	sealedPreprompt?: string;
	sealedPrepromptRev?: number;
	/** Personal instructions win over the conversation's own preprompt. */
	personalInstructionsApply?: boolean;
	/** Set when the sealed title or preprompt did not open here. */
	titleState?: SealedState;
	prepromptState?: SealedState;
	rootMessageId?: string;
	id: string;
	updatedAt: Date;
	modelId: string;
	shared: boolean;
	/** The former workspace this chat was in, when it is read-only for that reason. */
	formerWorkspace?: string | null;
	/** The Mila output guard ended this conversation on a flagged answer; no later turn is accepted. */
	crisisEnded?: boolean;
	/** When conversation expiry deletes this chat, for its owner; null when it never does. */
	expiresAt?: Date | null;
}

// The last conversation this tab loaded, browser only (on the server a module variable is shared
// by every visitor). The page reloads its own data when a turn ends, so a reload that fails while the
// visitor is offline must not replace the conversation on screen with the error page below.
let lastLoaded: ConversationData | undefined;

export const load: PageLoad = async ({ params, depends, fetch, url }) => {
	depends(UrlDependency.Conversation);

	const client = useAPIClient({ fetch, origin: url.origin });

	// Load the conversation. A share link opens at /r/<id> instead; upstream's import-share
	// route was never ported, so a 7-character id here is just an id that resolves to nothing.
	try {
		let data = (await client
			.conversations({ id: params.id })
			.get({ query: { fromShare: url.searchParams.get("fromShare") ?? undefined } })
			.then(handleResponse)) as ConversationData;
		// Sealed history opens in the browser with the unlocked key. The server render has no
		// key, so it shows the locked placeholders, never ciphertext; hydration reruns this with the key.
		// A conversation with nothing sealed skips this and never loads the cipher. Every blob is bound to
		// the id in the URL, not the one the response names, so a doc served at another chat's address
		// opens nothing.
		if (hasSealedFields(data)) {
			const { openConversationDoc } = await import("$lib/chat/crypto/sealedHistory");
			const identity = browser ? historyKeyring.identity : null;
			data = (await openConversationDoc(data, params.id, identity)) as ConversationData;
		}
		if (browser) lastLoaded = data;
		return data;
	} catch (err) {
		// A 404/403 here means the id doesn't resolve to a conversation THIS session owns —
		// most often an anonymous conversation from before signing in, or one opened from a different
		// browser. Distinct from any other failure (network blip, 500), which claims nothing about
		// ownership and is handled below.
		// A 400 is a malformed id, most often a link that lost its tail, so it gets the same note.
		if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 403)) {
			// On a direct load this runs on the server, where the store is not the visitor's,
			// so the message goes over the redirect as a param ChatShell reads on mount.
			if (!browser) redirect(302, `${base}/?unavailable=1`);
			error.set(ERROR_MESSAGES.conversationUnavailable);
			redirect(302, `${base}/`);
		}
		// The same conversation is already on screen, so this is the page reloading its own data
		// (a turn ending, a resync) and the failure is the connection's. Keep what the visitor sees; the
		// turn carries its own notice, and the next reload once the connection is back brings it current.
		if (browser && lastLoaded?.id === params.id) return lastLoaded;
		// Anything else (a 5xx, a dropped connection) says nothing about the chat itself, so the
		// visitor stays on its link, where a reload retries, instead of landing on an empty new chat.
		kitError(503, ERROR_MESSAGES.conversationCouldNotOpen);
	}
};
