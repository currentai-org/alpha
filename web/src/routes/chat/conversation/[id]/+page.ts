import { useAPIClient, handleResponse, ApiError } from "$lib/chat/APIClient";
import { UrlDependency } from "$lib/chat/types/UrlDependency";
import { error as kitError, redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { base } from "$lib/chat/paths";
import { ERROR_MESSAGES, error } from "$lib/chat/stores/errors";
import type { PageLoad } from "./$types";
import type { Message } from "$lib/chat/types/Message";

interface ConversationData {
	messages: Message[];
	title: string;
	model: string;
	preprompt?: string;
	rootMessageId?: string;
	id: string;
	updatedAt: Date;
	modelId: string;
	shared: boolean;
	/** The former workspace this chat was in, when it is read-only for that reason. (CUR-3040) */
	formerWorkspace?: string | null;
}

// The last conversation this tab loaded, browser only (on the server a module variable is shared
// by every visitor). The page reloads its own data when a turn ends, so a reload that fails while the
// visitor is offline must not replace the conversation on screen with the error page below. (CUR-2805)
let lastLoaded: ConversationData | undefined;

export const load: PageLoad = async ({ params, depends, fetch, url, parent }) => {
	depends(UrlDependency.Conversation);

	const client = useAPIClient({ fetch, origin: url.origin });

	// Handle share import for logged-in users (7-char IDs are share IDs)
	if (params.id.length === 7) {
		const parentData = await parent();

		if (parentData.loginEnabled && parentData.user) {
			const leafId = url.searchParams.get("leafId");

			let importedConversationId: string | undefined;
			try {
				const result = await client.conversations["import-share"]
					.post({ shareId: params.id })
					.then(handleResponse);
				importedConversationId = result.conversationId;
			} catch {
				// Import failed, continue to load shared conversation for viewing
			}

			if (importedConversationId) {
				redirect(
					302,
					`${base}/conversation/${importedConversationId}?leafId=${leafId ?? ""}&fromShare=${params.id}`
				);
			}
		}
	}

	// Load conversation (works for both owned and shared conversations)
	try {
		const data = (await client
			.conversations({ id: params.id })
			.get({ query: { fromShare: url.searchParams.get("fromShare") ?? undefined } })
			.then(handleResponse)) as ConversationData;
		if (browser) lastLoaded = data;
		return data;
	} catch (err) {
		// A 404/403 here means the id doesn't resolve to a conversation THIS session owns —
		// most often an anonymous conversation from before signing in, or one opened from a different
		// browser. Distinct from any other failure (network blip, 500), which claims nothing about
		// ownership and is handled below. (CUR-849)
		// A 400 is a malformed id, most often a link that lost its tail, so it gets the same note. (CUR-2821)
		if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 403)) {
			// On a direct load this runs on the server, where the store is not the visitor's,
			// so the message goes over the redirect as a param ChatShell reads on mount. (CUR-2626)
			if (!browser) redirect(302, `${base}/?unavailable=1`);
			error.set(ERROR_MESSAGES.conversationUnavailable);
			redirect(302, `${base}/`);
		}
		// The same conversation is already on screen, so this is the page reloading its own data
		// (a turn ending, a resync) and the failure is the connection's. Keep what the visitor sees; the
		// turn carries its own notice, and the next reload once the connection is back brings it current. (CUR-2805)
		if (browser && lastLoaded?.id === params.id) return lastLoaded;
		// Anything else (a 5xx, a dropped connection) says nothing about the chat itself, so the
		// visitor stays on its link, where a reload retries, instead of landing on an empty new chat. (CUR-2821)
		kitError(503, ERROR_MESSAGES.conversationCouldNotOpen);
	}
};
