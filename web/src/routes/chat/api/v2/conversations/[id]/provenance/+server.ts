// Machine-readable provenance for an agent consuming the chat (followups #9). PLAIN JSON (not the
// superjson the UI data-path uses) so any HTTP client can parse it. Returns one provenance envelope
// per assistant message in the conversation — what model ran, where, whether it searched, what it
// cited, and what the answer actually IS. Scoped to the caller (requireAuth + resolveConversation),
// so an agent reads provenance only for conversations it owns. Read-only.
import { type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { models } from "$lib/chat/server/models";
import { servingFor } from "$lib/chat/server/serving";
import { buildProvenanceEnvelope, PROVENANCE_SCHEMA } from "$lib/chat/utils/trace/provenanceEnvelope";

export const GET: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);
	const conversation = await resolveConversation(params.id ?? "", locals);

	// Serving host + checkpoint are deployment facts (same for every turn) — resolve once.
	const serving = servingFor(
		models.find((m) => m.id === conversation.model),
		conversation.model
	);
	const messages = conversation.messages
		.filter((m) => m.from === "assistant")
		.map((m) => buildProvenanceEnvelope(m, conversation.model, serving));

	return json({
		schema: PROVENANCE_SCHEMA,
		conversation: conversation._id.toString(),
		model: conversation.model,
		messages,
	});
};
