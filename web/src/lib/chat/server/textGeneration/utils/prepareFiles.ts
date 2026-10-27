// prepareMessagesWithFiles — OpenAI-payload formatter over the ONE shared media pass. Text-file and
// clipboard content is ALREADY spliced into message.content by prepareTurnMedia (budget-capped and
// screened by the gate), so this module does no text extraction — re-splicing
// would double-expand and reintroduce the unscreened path the shared step closed. Files on user
// messages are image occurrences only (base64 SOURCE bytes, named by sha), formatted through the
// endpoint's own imageProcessor when multimodal is on.

import type { EndpointMessage } from "$lib/chat/server/endpoints/types";
import type { OpenAI } from "openai";
import type { makeImageProcessor } from "$lib/chat/server/endpoints/images";

export async function prepareMessagesWithFiles(
	messages: EndpointMessage[],
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	isMultimodal: boolean
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
	return Promise.all(
		messages.map(async (message) => {
			if (isMultimodal && message.from === "user" && message.files && message.files.length > 0) {
				const processedFiles = await Promise.all(message.files.map(imageProcessor));
				const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] =
					processedFiles.map((file) => ({
						type: "image_url" as const,
						image_url: {
							url: `data:${file.mime};base64,${file.image.toString("base64")}`,
							detail: "auto",
						},
					}));

				if (imageParts.length > 0) {
					const parts = [{ type: "text" as const, text: message.content }, ...imageParts];
					return { role: message.from, content: parts };
				}
			}
			return { role: message.from, content: message.content };
		})
	);
}

/**
 * Leaves out assistant messages that carry neither text nor tool calls. A turn that failed with no
 * answer is kept in the conversation so the visitor can ask again (CUR-4494), and sent back as
 * history a backend that requires content or tool_calls on every assistant message refuses the whole
 * request with a 400 ("Assistant message must have either content or tool_calls"), so the re-asked question fails too. Run it after
 * withPastCalculations, which pairs this list with the source messages by index.
 */
export function withoutEmptyAnswers(
	messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
	return messages.filter((m) => {
		if (m.role !== "assistant" || m.tool_calls?.length) return true;
		const { content } = m;
		if (typeof content === "string") return content.trim().length > 0;
		return Array.isArray(content) && content.length > 0;
	});
}
