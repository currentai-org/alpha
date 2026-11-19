import { type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { sealedTitleIndex } from "$lib/chat/server/db/searchConversations";

/**
 * GET /chat/api/conversations/search/sealed — the caller's chats whose title is sealed, still sealed,
 * newest first. Search chats opens them in the browser with the history key and matches
 * the query there, since the server cannot. The same owner scope as the search beside it; no query is
 * sent, so the person's words never reach this route.
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	const rows = await sealedTitleIndex(
		locals.user?._id ? { userId: locals.user._id.toString() } : { sessionId: locals.sessionId }
	);
	return json({ conversations: rows }, { headers: { "Cache-Control": "private, no-store" } });
};
