import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import type { Conversation } from "$lib/chat/types/Conversation";
import { CONV_NUM_PER_PAGE } from "$lib/chat/constants/pagination";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import { tombstoneConversations } from "$lib/chat/server/sync/syncTouch";

export async function GET({ locals, url }) {
	const p = parseInt(url.searchParams.get("p") ?? "0");
	if (locals.user?._id || locals.sessionId) {
		const convs = await collections.conversations
			.find({
				...authCondition(locals),
			})
			.project<Pick<Conversation, "_id" | "title" | "updatedAt" | "model" | never>>({
				title: 1,
				updatedAt: 1,
				model: 1,
			})
			.sort({ updatedAt: -1 })
			.skip(p * CONV_NUM_PER_PAGE)
			.limit(CONV_NUM_PER_PAGE)
			.toArray();

		if (convs.length === 0) {
			return Response.json([]);
		}
		const res = convs.map((conv) => ({
			_id: conv._id,
			id: conv._id, // legacy param iOS
			title: conv.title,
			updatedAt: conv.updatedAt,
			model: conv.model,
			modelId: conv.model, // legacy param iOS
		}));
		return Response.json(res);
	} else {
		return Response.json({ message: "Must have session cookie" }, { status: 401 });
	}
}

export async function DELETE({ locals }) {
	if (locals.user?._id || locals.sessionId) {
		// FK-ordered cascade: resolve ids, then delete dependents + conversations in a transaction
		// (a bare deleteMany throws once any conversation has a report — NOT NULL FK).
		const convs = await collections.conversations
			.find(authCondition(locals))
			.project<Pick<Conversation, "_id" | "syncClientId" | "syncOrigin">>({ _id: 1, syncClientId: 1, syncOrigin: 1 })
			.toArray();
		// authCondition scopes a signed-in delete to the person's own conversations, so they own every one.
		await deleteConversationsCascade(
			convs.map((c) => c._id.toString()),
			locals.user?._id.toString(),
			locals.user ? undefined : locals.sessionId
		);
		await tombstoneConversations(locals, convs);
	}

	return new Response();
}
