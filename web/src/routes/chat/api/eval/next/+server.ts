// The next answer this person rates in a language (CUR-1914). Signed-in only.
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { humanEvalEnabled } from "$lib/chat/server/humanEval/gate";
import { nextItemFor } from "$lib/chat/server/humanEval/service";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!humanEvalEnabled()) throw error(404, "Not found");
	if (!locals.user) throw error(401, "Sign in to evaluate.");
	const language = url.searchParams.get("language");
	if (!language) throw error(400, "language is required");
	return json(await nextItemFor(locals.user._id.toString(), language));
};
