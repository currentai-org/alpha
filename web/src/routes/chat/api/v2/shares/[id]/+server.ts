import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { shareLinksEnabled } from "$lib/chat/server/shareLinksGate";
import { revokeShare } from "$lib/chat/server/share/sharedConversations";

/** Revokes one of the signed-in person's share links by its token. Another person's link,
 *  or one already gone, is a 404: the answer never says which. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!shareLinksEnabled()) error(404, "Not found");
	const userId = requireUserId(locals);
	if (!(await revokeShare(userId, params.id ?? ""))) error(404, "Share link not found");
	return json({ revoked: true });
};
