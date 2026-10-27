import type { RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { multimodalOnSignIn } from "$lib/chat/server/textOnly";

// Asked by the composer only when a guest's photo was just refused, so the PostHog request
// it costs is made for a guest who tried to attach one, never on a page load. A signed-in visitor's
// own answer is already on the page (`imageInputEnabled`), so for them this is always no. (CUR-3015)
export const GET: RequestHandler = async ({ locals }) => {
	const photos = locals.user ? false : await multimodalOnSignIn(locals.sessionId);
	return json({ photos }, { headers: { "Cache-Control": "private, max-age=60" } });
};
