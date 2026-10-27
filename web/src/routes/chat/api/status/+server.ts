import type { RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { statusPageState } from "$lib/chat/server/statusPage";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";

// Asked once per chat page load by the incident banner. The state is the same for every
// visitor, but `private` keeps a faulted answer out of any shared cache; the browser holds it for
// the minute the server does. (CUR-4062)
export const GET: RequestHandler = async ({ request }) => {
	const fault = await resolveFaultInjection(request);
	const state = fault === "status_page_degraded" ? "degraded" : await statusPageState();
	return json({ state }, { headers: { "Cache-Control": "private, max-age=60" } });
};
