import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { conversationExpiryEnabled } from "$lib/chat/server/conversationExpiry";
import { cannedContinueSummary, summariseForContinue } from "$lib/chat/server/continueSummary";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { hasSealedFields } from "$lib/chat/crypto/sealedShape";
import { hydratePostedHistory } from "$lib/chat/server/chat/sealedTurn";

// Continue in a new chat: the summary a conversation near its delete date hands to a new chat's
// composer. It reads the conversation and writes nothing, here or anywhere: the new chat exists only
// once the person sends it, and the old one is left as it was. A sealed conversation's words reach the
// server only as its owner's browser opens and posts them, checked against their stored MACs as share's
// are.
export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);
	if (!conversationExpiryEnabled()) error(404, "Not found");
	const conversation = await resolveConversation(params.id ?? "", locals);
	const body = (await request.json().catch(() => ({}))) as { leafId?: unknown; history?: unknown; preprompt?: unknown };
	if (hasSealedFields(conversation)) {
		hydratePostedHistory(conversation, conversation._id.toString(), body, "[continue]");
	}
	const summary =
		(await resolveFaultInjection(request)) === "canned_reply"
			? cannedContinueSummary(conversation)
			: await summariseForContinue(conversation, typeof body.leafId === "string" ? body.leafId : undefined, locals);
	if (!summary) error(502, "Alpha couldn't summarise this chat just now. Try again, or export it.");
	return json({ summary });
};
