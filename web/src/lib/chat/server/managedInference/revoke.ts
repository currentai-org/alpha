/**
 * Tears down a managed endpoint's Pangolin site and resource. Shared by the settings page's Remove
 * button (api/v2/user/local-inference-endpoints/[id]) and the daily sweep of pairings nobody
 * collected (sweepUncollectedPairings.ts), so both revoke the same way.
 *
 * Best effort. A failure is logged and reported, never thrown: neither caller should keep
 * a row the person can't use just because Pangolin's API was unreachable. A device that did pair
 * still needs `--remove-tunnel` on the device itself (see aipotluck-local-client); this only tears
 * down the server side. (CUR-1266)
 */
import { logger } from "$lib/chat/server/logger";
import { deleteSite, deletePublicResource } from "$lib/chat/server/managedInference/pangolinClient";
import type { ManagedEndpointConfig } from "$lib/chat/server/db/localInferenceEndpoints";

/** Whether both Pangolin deletes succeeded. */
export async function revokeManagedEndpoint(config: ManagedEndpointConfig, endpointId: string): Promise<boolean> {
	const results = await Promise.allSettled([deleteSite(config.siteId), deletePublicResource(Number(config.resourceId))]);
	let ok = true;
	for (const result of results) {
		if (result.status === "rejected") {
			ok = false;
			logger.warn(
				{ err: String(result.reason), endpointId },
				"[managedInference] Failed to revoke Pangolin site/resource — continuing"
			);
		}
	}
	return ok;
}
