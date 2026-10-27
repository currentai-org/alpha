import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { z } from "zod";

// The ownership check every agent-service proxy route under conversation/[id]/ shares (agent-artifact
// download, agent-confirm) — one path, so a fix cannot land on one copy and not the other (the
// dual-path bug class the duplication gate in scripts/audit-dup.mjs exists to catch). Same
// shape-authority reasoning as messageProvenance.ts.
//
// 404, never 401/403, when the id doesn't resolve to a conversation THIS caller owns — the ownership
// check and the existence check are deliberately the same response, so a probing request can't use the
// difference to enumerate other people's conversation ids.
export async function loadOwnedConversation(
	locals: App.Locals,
	rawId: string | undefined
): Promise<ObjectId> {
	const userId = locals.user?._id ?? locals.sessionId;
	if (!userId) {
		error(401, "Unauthorized");
	}

	const convId = new ObjectId(z.string().parse(rawId));
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});
	if (!conv) {
		error(404, "Conversation not found");
	}
	return convId;
}
