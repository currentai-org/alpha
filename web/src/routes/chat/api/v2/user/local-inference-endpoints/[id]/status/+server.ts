/** Poll one endpoint's health for the Settings UI's status icon — both "direct" and
 *  "managed" rows now go through here (see the collection route, `../../+server.ts`, for the shared
 *  auth/gate reasoning). The two kinds check different things but report the same shape:
 *  `{online, error?, modelIds?}` — `error` set means "show the amber exclamation mark, not a dot";
 *  `modelIds`, when present, is this poll's live discovery result, piggybacked onto the health check
 *  so the Settings UI can invalidate its model list only when that set actually changed.
 *
 *  Managed: two-stage check. (1) Is the Pangolin tunnel itself open? Closed -> plain offline (red
 *  dot) -- expected state for a paired device that's turned off, not an error. (2) Tunnel open -> is
 *  the inference server actually answering behind it? A closed tunnel makes stage 2 meaningless, so
 *  it only runs once stage 1 confirms the tunnel is up. (CUR-1267)
 *  Direct: single check -- is the server itself answering. No tunnel, so no stage 1. */
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireUserId } from "$lib/chat/server/api/utils/requireAuth";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { managedInferenceEnabled } from "$lib/chat/server/managedInferenceGate";
import { getLocalEndpointForUserAndId } from "$lib/chat/server/db/localInferenceEndpoints";
import { getSiteStatus, PangolinApiError } from "$lib/chat/server/managedInference/pangolinClient";
import { checkLocalEndpointModels, headersRecord } from "$lib/chat/server/localModels";
import { logger } from "$lib/chat/server/logger";

// Endpoint ids we've already logged a "site not found" error for, this process's
// lifetime -- the Settings UI polls every ~10s, and this state doesn't change on its own (it needs
// a human to remove/re-pair the row), so logging on every poll would spam the stream for no new
// information. Same "warn once" idiom as syftClient.ts's warnedUnconfigured. (CUR-1267)
const warnedSiteNotFound = new Set<string>();

const STALE_SITE_MESSAGE = "This server's Pangolin tunnel no longer exists — remove and re-pair it.";
const TUNNEL_UNRESPONSIVE_MESSAGE =
	"The Pangolin tunnel is open, but the inference server behind it didn't respond.";

export const GET: RequestHandler = async ({ locals, params }) => {
	const userId = requireUserId(locals);
	if (!localInferenceEndpointsEnabled()) error(404, "Not found");

	const row = await getLocalEndpointForUserAndId(userId, params.id ?? "");
	if (!row) error(404, "Not found");

	if (row.kind === "managed") {
		if (!row.managedConfig || !managedInferenceEnabled()) error(404, "Not found");

		try {
			const site = await getSiteStatus(row.managedConfig.niceId);
			if (!site.online) return superjsonResponse({ online: false });
		} catch (err) {
			// Pangolin has no record of this site at all -- distinct from a transient API failure
			// (network blip, Pangolin down for a moment), which the Settings UI already treats as
			// "unknown" rather than an error. This is a standing, structural mismatch: the row was
			// paired against a site that's since been deleted server-side (or belongs to a different
			// Pangolin org entirely, e.g. a leftover row from local-stack testing after switching to the
			// cloud org). Surface it as a per-row error the user can act on instead of a 500 on every poll.
			if (err instanceof PangolinApiError && err.status === 404) {
				if (!warnedSiteNotFound.has(row.id)) {
					warnedSiteNotFound.add(row.id);
					logger.error(
						{ err: err.message, endpointId: row.id, niceId: row.managedConfig.niceId },
						"[managedInference] Pangolin site not found for a managed endpoint -- surfacing as a row error, not dropping it"
					);
				}
				return superjsonResponse({ online: false, error: STALE_SITE_MESSAGE });
			}
			throw err;
		}

		// Tunnel is open -- secondary check: is the inference server behind it actually answering?
		try {
			const modelIds = await checkLocalEndpointModels(row.baseUrl, headersRecord(row.headers));
			return superjsonResponse({ online: true, modelIds });
		} catch {
			return superjsonResponse({ online: false, error: TUNNEL_UNRESPONSIVE_MESSAGE });
		}
	}

	// Direct (LAN/self-hosted) server -- no tunnel to check, just the server itself.
	try {
		const modelIds = await checkLocalEndpointModels(row.baseUrl, headersRecord(row.headers));
		return superjsonResponse({ online: true, modelIds });
	} catch {
		return superjsonResponse({ online: false });
	}
};
