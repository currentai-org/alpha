import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { shareLinksEnabled } from "$lib/chat/server/shareLinksGate";
import { listShares } from "$lib/chat/server/share/sharedConversations";

/** Every live share link the signed-in person has made, newest first. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!shareLinksEnabled()) error(404, "Not found");
	const userId = requireUserId(locals);
	return json({ shares: await listShares(userId) });
};
