/**
 * The daily cleanup cron route (routes/chat/api/cleanup), against the real database. Pangolin and the
 * guest-file bucket are the only things replaced.
 *
 * CUR-4110's contract here is ordering: the sweep of uncollected pairings must run BEFORE
 * cleanupExpired(), which deletes expired pairing rows. The other way round, the rows that say which
 * endpoints were never collected are gone first, and those endpoints are never removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTestData, createTestUser } from "./testHelpers";
import { createLocalEndpoint, listLocalEndpointsForUserId } from "$lib/chat/server/db/localInferenceEndpoints";
import { claimPairing, completePairing } from "$lib/chat/server/db/localInferencePairings";
import { eq } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { safetyEvents } from "$lib/chat/server/db/schema";

vi.mock("$env/dynamic/private", () => ({ env: { CRON_SECRET: "cron-secret" } }));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({
	sweepExpiredGuestFiles: vi.fn(async () => ({ deleted: 0, failed: 0, undated: 0 })),
}));
const revoke = vi.hoisted(() => vi.fn(async () => true));
vi.mock("$lib/chat/server/managedInference/revoke", () => ({ revokeManagedEndpoint: revoke }));

import { GET } from "../../../../../routes/chat/api/cleanup/+server";

function runCron(authorization?: string) {
	const headers = authorization ? { authorization } : undefined;
	return GET({ request: new Request("http://localhost/chat/api/cleanup", { headers }) } as never);
}

describe("cleanup cron route — CUR-4110 uncollected pairings", () => {
	beforeEach(async () => {
		revoke.mockClear();
		await cleanupTestData();
	});

	it("removes an endpoint whose pairing expired uncollected, which only works if the sweep runs before the TTL cleanup", async () => {
		const { user } = await createTestUser();
		const userId = user._id.toString();
		const managedConfig = { provider: "pangolin" as const, siteId: 7, niceId: "n7", resourceId: "7" };
		const endpoint = await createLocalEndpoint({
			userId,
			label: "never-collected",
			baseUrl: "https://nc.example/v1",
			kind: "managed",
			managedConfig,
		});
		const pairingId = "z".repeat(40);
		await claimPairing(userId, pairingId, new Date(Date.now() - 11 * 60 * 1000));
		await completePairing(userId, pairingId, {
			endpointId: endpoint.id,
			label: endpoint.label,
			installArgs: { tunnelId: "t", tunnelSecret: "s", tunnelEndpoint: "e" },
		});

		const res = await runCron("Bearer cron-secret");
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.uncollectedPairings).toEqual({ endpointsRemoved: 1, revokeFailures: 0, errors: 0 });
		expect(revoke).toHaveBeenCalledWith(managedConfig, endpoint.id);
		expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
	});

	it("deletes a 61-day-old safety record and reports it in deleted.safetyEvents (CUR-4428)", async () => {
		const id = `cur4428-route-${crypto.randomUUID()}`;
		await getDb()
			.insert(safetyEvents)
			.values({ id, kind: "content_policy", label: "test", createdAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000) });

		const res = await runCron("Bearer cron-secret");
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.deleted.safetyEvents).toBeGreaterThanOrEqual(1);
		expect(await getDb().select().from(safetyEvents).where(eq(safetyEvents.id, id))).toEqual([]);
	});

	it("refuses a request without the cron secret and removes nothing", async () => {
		const res = await runCron();
		expect(res.status).toBe(401);
		expect(revoke).not.toHaveBeenCalled();
	});
});
