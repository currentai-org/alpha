import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutFeatureFlags } from "$lib/chat/server/layoutData";

export const GET: RequestHandler = async ({ locals }) => {
	// MUST await: getLayoutFeatureFlags is async (per-tester agent gate). `superjsonResponse(data: unknown)`
	// accepts a Promise without complaint and stringifies it to `{}`, so a missing await answers 200 with an
	// empty body — every flag missing — and typecheck stays green. The `unknown` param is why nothing
	// catches it; the await is what makes the response the flags rather than the promise of them.
	return superjsonResponse(await getLayoutFeatureFlags(locals));
};
