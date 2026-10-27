/**
 * The daily sweep of one-click pairings nobody collected. Run by the cleanup cron
 * (routes/chat/api/cleanup) BEFORE cleanupExpired(), which deletes expired pairing rows and with them
 * the only record of which endpoints were never collected.
 *
 * Approving the pairing link provisions a managed endpoint at once: a row in the person's Settings
 * list and a Pangolin site, resource and access token. If the CLI never collects the credentials
 * (killed, laptop closed), that endpoint can never come online, and without this sweep it stays in
 * the list and in Pangolin until removed by hand. A pairing past its expiry can no longer be
 * collected (collectPairing refuses it), so revoking its endpoint cannot cut off a device that was
 * about to connect.
 *
 * Bounded per run, so one cron invocation stays well inside the function's time limit; a backlog
 * drains over the following nights. Each endpoint is revoked best-effort, the way the Remove button
 * does it, and deleted even when Pangolin can't be reached, for the same reason. (CUR-4110)
 */
import { logger } from "$lib/chat/server/logger";
import { listUncollectedExpiredPairings } from "$lib/chat/server/db/localInferencePairings";
import { deleteLocalEndpoint } from "$lib/chat/server/db/localInferenceEndpoints";
import { revokeManagedEndpoint } from "$lib/chat/server/managedInference/revoke";

const SWEEP_LIMIT = 50;

export type UncollectedPairingSweep = {
	/** Endpoints deleted (each took its pairing with it). */
	endpointsRemoved: number;
	/** Of those, how many had a Pangolin revoke fail and may have left a site behind. */
	revokeFailures: number;
	/** Rows that failed outright and stay for the next run. */
	errors: number;
};

export async function sweepUncollectedPairings(
	now: Date = new Date(),
	deps: { limit?: number; revoke?: typeof revokeManagedEndpoint } = {}
): Promise<UncollectedPairingSweep> {
	const revoke = deps.revoke ?? revokeManagedEndpoint;
	const rows = await listUncollectedExpiredPairings(deps.limit ?? SWEEP_LIMIT, now);
	const result: UncollectedPairingSweep = { endpointsRemoved: 0, revokeFailures: 0, errors: 0 };

	for (const row of rows) {
		try {
			if (row.managedConfig && !(await revoke(row.managedConfig, row.endpointId))) result.revokeFailures++;
			if (await deleteLocalEndpoint(row.userId, row.endpointId)) result.endpointsRemoved++;
		} catch (err) {
			result.errors++;
			logger.error(
				{ err: err instanceof Error ? err.message : String(err), endpointId: row.endpointId },
				"[managedInference] uncollected pairing sweep failed on one endpoint"
			);
		}
	}
	return result;
}
