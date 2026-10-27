import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";

/** A side call, so it runs on TASK_MODEL rather than the model that is reasoning (CUR-2092). */
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
