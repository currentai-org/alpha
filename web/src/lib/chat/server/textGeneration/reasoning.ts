// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";

/** A side call, so it runs on TASK_MODEL rather than the model that is reasoning. */
export async function generateSummaryOfReasoning(
	reasoning: string,
	locals: App.Locals | undefined
): Promise<string> {
	const prompt = `Summarize concisely the following reasoning for the user. Keep it short (one short paragraph).\n\n${reasoning}`;
	const summary = await (async () => {
		const it = generateFromDefaultEndpoint({
			messages: [{ from: "user", content: prompt }],
			locals,
		});
		let out = "";
		for await (const update of it) {
			if (update.type === MessageUpdateType.Stream) out += update.token;
		}
		return out;
	})();
	return summary.trim();
}
