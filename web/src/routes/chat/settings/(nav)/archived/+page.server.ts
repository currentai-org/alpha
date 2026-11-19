import { getLayoutConversations } from "$lib/chat/server/layoutData";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import type { PageServerLoad } from "./$types";

// Settings → Archived chats: the first page of the chats this visitor archived. Later pages
// come from GET /chat/api/v2/conversations?archived=1, which scopes by workspace the same way, so the
// pages of one list never disagree about which chats belong in it.
export const load: PageServerLoad = async ({ locals, request }) => {
	const scope = await workspaceScopeFor(locals, request.headers);
	const { conversations, hasMore } = await getLayoutConversations(locals, 0, scope, "archived");
	return {
		archived: conversations.map((c) => ({
			id: c._id.toString(),
			title: c.title.trim(),
			updatedAt: new Date(c.updatedAt).toISOString(),
		})),
		hasMore,
	};
};
