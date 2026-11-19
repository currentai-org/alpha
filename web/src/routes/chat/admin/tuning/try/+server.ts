// Admin tuning panel: run a query against the editor's UNSAVED draft persona
// so a reviewer can iterate wording without saving-to-prod and tab-switching to the chat. One
// non-streaming model call; returns the answer AND the assembled system prompt. Admin-gated.
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";
import { defaultModel } from "$lib/chat/server/models";
import { buildPersonaPrompt, resolveDecoding } from "$lib/chat/server/textGeneration/persona";
import type { RequestHandler } from "./$types";

const TryBody = z.object({
	query: z.string().min(1).max(4000),
	// The draft persona from the editor's textarea (blank → the built-in default is tested).
	persona: z.string().max(20000).optional(),
});

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { tuning: "try" });

	const parsed = TryBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, "query is required");
	const { query, persona } = parsed.data;

	const model = defaultModel?.id ?? defaultModel?.name ?? "";
	// Same identity-token fill as the live chat, so the test reflects what users would see.
	const system = buildPersonaPrompt(model, persona);
	const dec = resolveDecoding(); // v1: default decoding (persona is what's being tuned)

	try {
		// The model's own endpoint, the one a chat turn calls: its lanes send the wire id the host
		// knows (`mistral-medium-2604` is our picker id, not a name the gateway accepts) and use the
		// lane's own base URL and key. Unlike generateFromDefaultEndpoint, a failure throws,
		// so the operator sees the refusal instead of an empty answer.
		const endpoint = await defaultModel.getEndpoint();
		const stream = await endpoint({
			messages: [{ from: "user", content: query }],
			preprompt: system,
			generateSettings: dec,
			abortSignal: AbortSignal.timeout(60_000), // a hung gateway surfaces as an error, not a spinner
			locals,
		});
		let streamed = "";
		let answer = "";
		for await (const out of stream) {
			if (out.generated_text) {
				answer = out.generated_text;
				break;
			}
			streamed += out.token?.text ?? "";
		}
		return json({ answer: answer || streamed, system });
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : "model call failed");
	}
};
