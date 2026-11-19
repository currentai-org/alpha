import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { ObjectId } from "bson";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { collections } from "$lib/chat/server/database";
import { shareLinksEnabled } from "$lib/chat/server/shareLinksGate";
import {
	revokeShareForConversation,
	shareConversation,
	shareForConversation,
} from "$lib/chat/server/share/sharedConversations";
import { hasSealedFields } from "$lib/chat/crypto/sealedShape";
import { hydratePostedHistory } from "$lib/chat/server/chat/sealedTurn";

/** A sealed chat's opened bodies and preprompt, in the turn's own shape. */
/** As long as a title can be renamed to (PATCH conversations/[id]). */
const TITLE_MAX = 100;

// A conversation's read-only share link. GET says whether it has one, POST creates it or
// refreshes its snapshot (the link stays the same), DELETE revokes it. Signed in only: a link needs an
// owner who can list and revoke it later, and a guest's chats expire.

async function ownConversation(locals: App.Locals, id: string | undefined) {
	if (!shareLinksEnabled()) error(404, "Not found");
	const userId = requireUserId(locals);
	if (!id || !ObjectId.isValid(id)) error(400, "Invalid conversation ID");
	const conversation = await collections.conversations.findOne({
		_id: new ObjectId(id),
		userId: locals.user!._id,
	});
	if (!conversation) error(404, "Conversation not found");
	return { userId, conversation };
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const { userId, conversation } = await ownConversation(locals, params.id);
	return json({ share: await shareForConversation(userId, conversation._id.toString()) });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const { userId, conversation } = await ownConversation(locals, params.id);
	// A chat the output guard ended on a flagged answer is not passed on.
	if (conversation.crisisEndedAt) error(403, "This conversation can't be shared.");
	const body = (await request.json().catch(() => ({}))) as {
		leafId?: unknown;
		history?: unknown;
		preprompt?: unknown;
		title?: unknown;
	};
	const leafId = typeof body?.leafId === "string" ? body.leafId : undefined;
	// A sealed chat is a release: the server cannot open it, so the owner's
	// browser opens it and posts each sealed message's body, checked against the MAC stored with it as a
	// turn's history is, so the link shows what the chat holds and nothing else. The title has no MAC;
	// it is the owner's to name, as a rename is. Only the snapshot is written: the conversation row is
	// never touched, so it stays sealed.
	if (hasSealedFields(conversation)) {
		hydratePostedHistory(conversation, conversation._id.toString(), body, "[share]");
		if (conversation.sealedTitle) {
			conversation.title = typeof body?.title === "string" ? body.title.slice(0, TITLE_MAX) : "";
		}
	}
	const share = await shareConversation(userId, conversation, leafId);
	return json({ share });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { userId, conversation } = await ownConversation(locals, params.id);
	const revoked = await revokeShareForConversation(userId, conversation._id.toString());
	return json({ revoked });
};
