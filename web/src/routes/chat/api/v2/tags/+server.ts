import { type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { listTags } from "$lib/chat/server/db/conversationTags";

/**
 * GET /chat/api/v2/tags: the tags on the caller's sidebar chats, by name, for the sidebar's filter row
 * and the chat menu's Tags dialog. A guest has no tags, so gets an empty list rather than
 * an error the sidebar would have to handle. Superjson, like every route the APIClient reads through
 * handleResponse.
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	const tags = locals.user?._id ? await listTags(locals.user._id.toString()) : [];
	return superjsonResponse({ tags }, { headers: { "Cache-Control": "private, no-store" } });
};
