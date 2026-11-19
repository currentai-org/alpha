// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { EndpointParameters } from "./server/endpoints/types";
import type { BackendModel } from "./server/models";

type buildPromptOptions = Pick<EndpointParameters, "messages" | "preprompt"> & {
	model: BackendModel;
};

export async function buildPrompt({
	messages,
	model,
	preprompt,
}: buildPromptOptions): Promise<string> {
	const filteredMessages = messages;

	if (filteredMessages[0].from === "system" && preprompt) {
		filteredMessages[0].content = preprompt;
	}

	const prompt = model
		.chatPromptRender({
			messages: filteredMessages.map((m) => ({
				...m,
				role: m.from,
			})),
			preprompt,
		})
		// Not super precise, but it's truncated in the model's backend anyway
		.split(" ")
		.slice(-(model.parameters?.truncate ?? 0))
		.join(" ");

	return prompt;
}
