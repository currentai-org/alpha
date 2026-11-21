import type { RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { statusPageState, statusPageUrl } from "$lib/chat/server/statusPage";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";

// Asked once per chat page load by the incident banner. The state is the same for every
// visitor, but `private` keeps a faulted answer out of any shared cache; the browser holds it for
// the minute the server does.
export const GET: RequestHandler = async ({ request }) => {
	// `url` is the page the banner links to; null means this deployment has no status page, so no banner.
	const url = statusPageUrl();
	const fault = await resolveFaultInjection(request);
	const state = url && fault === "status_page_degraded" ? "degraded" : await statusPageState();
	return json({ state, url }, { headers: { "Cache-Control": "private, max-age=60" } });
};
