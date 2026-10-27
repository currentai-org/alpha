import { type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { searchConversations } from "$lib/chat/server/db/searchConversations";

/**
 * POST /chat/api/conversations/search with `{ q }` — the caller's own chats whose title or
 * messages contain `q`, newest first (CUR-2630). A guest searches the chats of their session, the
 * same scope as the sidebar list.
 *
 * @remarks `q` travels in the body because request logs keep the URL and its query string, and a
 * search is the person's own words (CUR-4546).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const body = (await request.json().catch(() => null)) as { q?: unknown } | null;
	const hits = await searchConversations(
		locals.user?._id
			? { userId: locals.user._id.toString() }
			: { sessionId: locals.sessionId },
		typeof body?.q === "string" ? body.q : ""
	);
	return json({ conversations: hits }, { headers: { "Cache-Control": "private, no-store" } });
};
