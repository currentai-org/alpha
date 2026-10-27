import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { loadOwnedConversation } from "$lib/chat/server/loadOwnedConversation";
import { submitElicitationAnswer } from "$lib/chat/server/mcp/elicitation";

// Separate from the generation stream (CUR-1017): the run that parked this may be on another
// instance entirely by the time this answer arrives — see db/schema.ts's mcpElicitations comment.
const bodySchema = z.object({
	elicitationId: z.string().min(1),
	action: z.enum(["accept", "decline", "cancel"]),
	// Shape-checked here only; the real check is against the stored requested schema
	// (submitElicitationAnswer re-validates server-side).
	content: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
		.optional(),
});

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conversationId = await loadOwnedConversation(locals, params.id);

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid elicitation response");

	const result = await submitElicitationAnswer({
		elicitationId: parsed.data.elicitationId,
		conversationId,
		action: parsed.data.action,
		content: parsed.data.content,
	});

	if (!result.ok) error(result.status, result.error);

	// A resumed 2026-era call re-issues on a fresh turn against `result.pending`; there is no
	// blocking call left anywhere to unblock.
	return json({ ok: true, resume: result.resume });
};
