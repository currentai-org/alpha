// Picks which former workspace (one the person left, or that was deleted) the conversation
// list shows, or clears the pick. Only a workspace in the caller's own former list is accepted, so the
// cookie can never name a workspace whose chats this person doesn't have. (CUR-3040)
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import { FORMER_WORKSPACE_COOKIE } from "$lib/chat/server/formerWorkspaces";

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	requireAuth(locals);
	const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
	const id = typeof body?.id === "string" ? body.id : null;
	if (id === null) {
		cookies.delete(FORMER_WORKSPACE_COOKIE, { path: "/" });
		return json({ viewing: null });
	}
	const scope = await workspaceScopeFor(locals, request.headers);
	const picked = scope?.former.find((w) => w.id === id);
	if (!picked) error(404, "You have no chats from that workspace.");
	cookies.set(FORMER_WORKSPACE_COOKIE, picked.id, {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: request.url.startsWith("https:"),
	});
	return json({ viewing: picked });
};
