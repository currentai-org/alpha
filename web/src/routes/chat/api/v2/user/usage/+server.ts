import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { getAccountUsage } from "$lib/chat/server/accountUsage";

// The caller's own usage (counts only) and the limits that apply to them — Settings → Data & privacy.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "No session");
	return json(await getAccountUsage(locals));
};
