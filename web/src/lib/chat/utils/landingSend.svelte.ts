import { goto } from "$app/navigation";
import { base } from "$lib/chat/paths";
import { ERROR_MESSAGES, error } from "$lib/chat/stores/errors";
import { requestNewConversation } from "$lib/chat/utils/createConversation";
import { encodeMessageFiles } from "$lib/chat/utils/messageFiles";
import { storePendingFiles } from "$lib/chat/utils/pendingFiles";
import { stopBeforeHandoff } from "$lib/chat/utils/pendingStop";
import type { Message } from "$lib/chat/types/Message";

/** What a page that starts a chat supplies for each send. */
export interface LandingSend {
	message: string;
	files: File[];
	settings: Parameters<typeof requestNewConversation>[1];
	convsStore: {
		prepend(conv: { id: string; title: string; model: string; updatedAt: Date }): void;
	};
	/** Called after the pending bubble shows, so a slow pick (Auto routing) doesn't delay it. */
	pickModel: () => string;
	setLoading: (on: boolean) => void;
}

/**
 * Sends a first message from either page that starts a chat (`ChatLanding.svelte` and
 * `routes/chat/models/[...model]`): creates the conversation, then hands the message to its page.
 * One shared copy keeps a fix (CUR-2971's Stop, CUR-3890) from landing on one page and missing the other.
 */
export function createLandingSend(draft: { get: () => string; set: (text: string) => void }) {
	// The composer empties on submit and the conversation page doesn't exist until the round
	// trip ends, so one synthetic user bubble shows the message meanwhile; the real page's own list
	// takes over once navigation lands. (CUR-1706)
	let pendingMessages: Message[] = $state([]);

	// Stop pressed before the conversation page has taken over is held here and recorded
	// against the new conversation once it exists; that page then stops the turn. (CUR-2971)
	const stopHold = stopBeforeHandoff();

	/** Takes the bubble back and returns the text to the composer, for a send that never became a
	 *  conversation (CUR-2875). A draft typed since is kept rather than overwritten. */
	function restoreUnsent(message: string) {
		pendingMessages = [];
		if (!draft.get().trim()) draft.set(message);
	}

	async function sendFromLanding(send: LandingSend): Promise<void> {
		const { message } = send;
		stopHold.reset();
		// Once navigation lands, the conversation page owns loading: its writeMessage has already set it
		// for the turn it just started. Clearing it here after `goto` resolves would turn Stop back into Send
		// for the whole pre-stream phase, and a follow-up sent then would be lost.
		let handedOff = false;
		try {
			send.setLoading(true);
			// The bubble carried only the text, so a photo or file looked dropped until the
			// conversation page took over seconds later. A read the browser refuses leaves the bubble
			// text-only; the conversation page's own encode then reports it. (CUR-3402)
			const files = send.files.length > 0 ? await encodeMessageFiles(send.files).catch(() => undefined) : undefined;
			pendingMessages = [{ id: "pending-user-message", content: message, from: "user", files }];
			const model = send.pickModel();
			const conversationId = await requestNewConversation(model, send.settings);
			if (!conversationId) {
				// No conversation was made, so nothing will ever answer the bubble. Left shown, "Working on
				// it…" counted forever and the typed text was gone.
				restoreUnsent(message);
				return;
			}
			stopHold.arrived(conversationId);

			// The first message travels in SvelteKit history state, which must be JSON-serializable. File
			// objects are not, so they wait in a client-side Map under a random nonce, and the nonce travels
			// instead; the conversation page consumes it once.
			const pendingFilesNonce = send.files.length > 0 ? storePendingFiles(send.files) : undefined;

			// Shown in the sidebar before the first token streams. "New Chat" matches the server-side
			// default title; the real one arrives as a Title stream update.
			// A timestamp handed to the store, never mutated here, so it needs no SvelteDate.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			send.convsStore.prepend({ id: conversationId, title: "New Chat", model, updatedAt: new Date() });
			await goto(`${base}/conversation/${conversationId}`, {
				// SvelteKit scrolls to the top on navigation, and sending a first message is an in-place
				// action: on the marketing-embedded page the jump yanked the just-sent turn off screen.
				noScroll: true,
				state: { pendingMessage: message, pendingFilesNonce },
			});
			handedOff = true;
		} catch (err) {
			error.set((err as Error).message || ERROR_MESSAGES.default);
			console.error(err);
			restoreUnsent(message);
		} finally {
			if (!handedOff) send.setLoading(false);
		}
	}

	return {
		get pendingMessages() {
			return pendingMessages;
		},
		stop: () => stopHold.stop(),
		send: (send: LandingSend) => sendFromLanding(send),
	};
}
