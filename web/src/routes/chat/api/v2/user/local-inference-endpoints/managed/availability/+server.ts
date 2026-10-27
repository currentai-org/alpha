/** Can a managed device actually be paired RIGHT NOW? Distinct from `managedLocalInferenceEndpointsEnabled()`
 *  (whether the feature exists on this deployment at all, which the Settings UI uses to show/hide the
 *  whole "Add a managed server" block) — this is the live, dynamic half: Pangolin's own env vars can
 *  be present but the instance down, or absent entirely, and both should read as "unavailable" rather
 *  than 404 the block out of existence. The UI uses this to disable the Pair control with a tooltip
 *  instead. See the collection route (`../../+server.ts`) for the shared auth/gate reasoning.
 *
 *  `listDomains()` doubles as the reachability probe rather than a bespoke health-check call:
 *  bootstrap.sh's own fast-path check (pangolin/scripts/bootstrap.sh) already uses the equivalent
 *  domains lookup to prove a token works end-to-end, and a plain network ping wouldn't also catch a
 *  wrong org id/token — which is just as "unavailable" from this feature's point of view. */
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import {
	managedLocalInferenceEndpointsEnabled,
	pangolinConfigured,
} from "$lib/chat/server/managedInferenceGate";
import { listDomains } from "$lib/chat/server/managedInference/pangolinClient";
import { logger } from "$lib/chat/server/logger";

export const GET: RequestHandler = async ({ locals }) => {
	requireUserId(locals);
	if (!managedLocalInferenceEndpointsEnabled()) error(404, "Not found");

	if (!pangolinConfigured()) return superjsonResponse({ available: false });

	try {
		await listDomains();
		return superjsonResponse({ available: true });
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"[managedInference] Pangolin unreachable — pairing withheld"
		);
		return superjsonResponse({ available: false });
	}
};
