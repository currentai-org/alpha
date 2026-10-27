import { get } from "svelte/store";
import { base } from "$lib/chat/paths";
import { ERROR_MESSAGES, error, errorHeld } from "$lib/chat/stores/errors";

/** The two settings fields the new-conversation request reads. `$settings` from the
 *  settings store satisfies this structurally. */
interface PrepromptSettings {
	customPrompts: Record<string, string>;
	customPromptsEnabled?: Record<string, boolean>;
}

export { PERSONAL_INSTRUCTIONS_KEY } from "$lib/chat/personalInstructions";

/**
 * The extra instructions sent with a new conversation. The server always prepends Alpha's persona
 * (textGeneration/index.ts), so this can only ADD context, never replace the persona.
 *
 * Personalization's instructions (key `*`) are NOT sent here: the server reads them on every turn
 * (turnPreferences.ts), so an edit reaches chats that are already open (CUR-1443). A copy stored on
 * the conversation would outlive the person changing or clearing them.
 */
export function prepromptFor(model: string, settings: PrepromptSettings): string | undefined {
	// Undefined (not "") when nothing is set, so the server falls back to the model's own preprompt.
	return (settings.customPromptsEnabled?.[model] ?? true) ? settings.customPrompts[model] : "";
}

/**
 * Single source of truth for the `POST /conversation` request that both entry points
 * (`/` and `/models/[...model]`) issue to start a chat. One copy of the body + error
 * handling keeps a change to the request contract in a single place. The preprompt is
 * keyed on the SAME `model` that is sent, never on the unresolved `$settings.activeModel`.
 *
 * On failure it sets the `error` store (with the richer auth/JSON-message handling the
 * home route had) and returns `null`; callers own their own loading state and the
 * post-creation navigation.
 */
export async function requestNewConversation(
	model: string,
	settings: PrepromptSettings
): Promise<string | null> {
	const res = await fetch(`${base}/conversation`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			preprompt: prepromptFor(model, settings),
		}),
	});

	if (!res.ok) {
		let errorMessage = ERROR_MESSAGES.default;
		try {
			const json = await res.json();
			errorMessage = json.message || errorMessage;
		} catch {
			// Response wasn't JSON (e.g., HTML error page)
			if (res.status === 401) {
				errorMessage = "Authentication required";
			}
		}
		error.set(errorMessage);
		// A refusal (the conversation cap's 429, a 400) is a reason the person has to act on, so the
		// toast is held like a refused send's (CUR-1896) rather than flashing for five seconds (CUR-2875).
		if (res.status < 500) errorHeld.set(true);
		console.error("Error while creating conversation: ", errorMessage);
		return null;
	}

	// The server made the chat, so a held refusal from an earlier try (the cap's 429) no longer
	// applies. Left up, it sat over the answer for its whole 20 s hold (CUR-2979).
	if (get(errorHeld)) {
		error.set(undefined);
		errorHeld.set(false);
	}
	const { conversationId } = await res.json();
	return conversationId as string;
}
