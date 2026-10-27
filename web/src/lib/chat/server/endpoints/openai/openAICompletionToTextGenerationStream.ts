import type { TextGenerationStreamOutput } from "@huggingface/inference";
import type OpenAI from "openai";
import type { Stream } from "openai/streaming";
import { TRUNCATION_NOTICE } from "./openAIChatToTextGenerationStream";

/**
 * Transform a stream of OpenAI.Completions.Completion into a stream of TextGenerationStreamOutput
 */
export async function* openAICompletionToTextGenerationStream(
	completionStream: Stream<OpenAI.Completions.Completion>
) {
	let generatedText = "";
	let tokenId = 0;
	for await (const completion of completionStream) {
		const { choices } = completion;
		const text = choices?.[0]?.text ?? "";
		const last = choices?.[0]?.finish_reason === "stop" || choices?.[0]?.finish_reason === "length";
		if (text) {
			generatedText = generatedText + text;
		}
		// Honest "cut off" notice on a length truncation (see openAIChatToTextGenerationStream) — append to
		// the final streamed token + the accumulated text, only when there's real content.
		let emitText = text;
		if (last && choices?.[0]?.finish_reason === "length" && generatedText.trim().length > 0) {
			emitText += TRUNCATION_NOTICE;
			generatedText += TRUNCATION_NOTICE;
		}
		const output: TextGenerationStreamOutput = {
			token: {
				id: tokenId++,
				text: emitText,
				logprob: 0,
				special: last,
			},
			generated_text: last ? generatedText : null,
			details: null,
		};
		yield output;
	}
}
