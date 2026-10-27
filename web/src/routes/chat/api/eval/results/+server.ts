// How each model does in a language, from people's ratings (aggregate.ts). Open to signed-out
// visitors: it carries only counts and, past the thresholds, shares and means, never a rating or a rater.
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { humanEvalEnabled } from "$lib/chat/server/humanEval/gate";
import { resultsFor } from "$lib/chat/server/humanEval/service";

export const GET: RequestHandler = async ({ url }) => {
	if (!humanEvalEnabled()) throw error(404, "Not found");
	const language = url.searchParams.get("language");
	if (!language) throw error(400, "language is required");
	return json(await resultsFor(language));
};
