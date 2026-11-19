// The prompt behind one answer, for XRAY's "This answer" tab. The server cannot open a sealed chat, so for one this
// tab opens it and posts the opened bodies, and the server rebuilds the prompt from those after checking
// each against its stored MAC. A chat with nothing sealed is read as before, with a GET.

import { base } from "$lib/chat/paths";
import { sealedHistoryForRequest } from "./sealedRequest";

export type MessagePrompt = { prompt: string; model: string };

/** Why the prompt could not be shown, in words for the person. */
export class PromptViewError extends Error {
	override name = "PromptViewError";
}

/**
 * The rendered prompt behind `messageId`. Throws `PromptViewError` with the server's reason when it is
 * refused (a sealed chat this browser has not unlocked, a body that does not match), never an empty prompt.
 */
export async function messagePrompt(
	conversationId: string,
	messageId: string,
	identity: string | null,
	fetcher: typeof fetch = fetch
): Promise<MessagePrompt> {
	const sealed = await sealedHistoryForRequest(conversationId, identity);
	const url = `${base}/conversation/${encodeURIComponent(conversationId)}/message/${encodeURIComponent(messageId)}/prompt`;
	const res =
		sealed.history || sealed.preprompt
			? await fetcher(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(sealed),
				})
			: await fetcher(url);
	const body = (await res.json().catch(() => null)) as (Partial<MessagePrompt> & { message?: string }) | null;
	if (!res.ok || typeof body?.prompt !== "string") {
		throw new PromptViewError(body?.message || `The prompt could not be loaded (${res.status}).`);
	}
	return { prompt: body.prompt, model: body.model ?? "" };
}
