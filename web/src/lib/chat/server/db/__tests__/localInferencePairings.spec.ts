/**
 * The CLI's pairing handoff against the real table. The contracts: one visit provisions per
 * pairing id however many race for it, the parked credentials come out of the poll exactly once and
 * leave the table as they do, and an id held by one account never hands anything to another. (CUR-4110)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The pool defaults to one connection (client.ts), which runs every query in turn and would let the
// racing tests below pass with no locking at all. Five connections make the races real. The pool is
// built on the first getDb() call, so setting this before any test runs is enough.
vi.hoisted(() => {
	process.env.PG_POOL_MAX = "5";
});
import { sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { createLocalEndpoint } from "$lib/chat/server/db/localInferenceEndpoints";
import {
	claimPairing,
	collectPairing,
	completePairing,
	isValidPairingId,
	releasePairing,
	type LocalInferencePairingCredentials,
} from "$lib/chat/server/db/localInferencePairings";
import { cleanupExpired } from "$lib/chat/server/db/cleanup";
import { listLocalEndpointsForUserId } from "$lib/chat/server/db/localInferenceEndpoints";
import { sweepUncollectedPairings } from "$lib/chat/server/managedInference/sweepUncollectedPairings";
import { cleanupTestData, createTestUser as createUser } from "$lib/chat/server/api/__tests__/testHelpers";

async function createTestUser(): Promise<{ userId: string }> {
	const { user } = await createUser();
	return { userId: user._id.toString() };
}

const PAIRING_ID = "a".repeat(20) + "B".repeat(12) + "_-xyz";

async function managedEndpointFor(userId: string) {
	return createLocalEndpoint({ userId, label: "Workstation", baseUrl: "https://ws.example/v1", kind: "managed" });
}

function credentialsFor(endpointId: string): LocalInferencePairingCredentials {
	return {
		endpointId,
		label: "Workstation",
		installArgs: { tunnelId: "newt-id", tunnelSecret: "newt-secret", tunnelEndpoint: "https://tunnel.example" },
	};
}

/** Opens every pooled connection up front. postgres.js connects lazily, so without this the first
 *  racer finishes before the others have a connection, and the race never happens. */
async function warmPool(): Promise<void> {
	await Promise.all(Array.from({ length: 5 }, () => getDb().execute(sql`SELECT pg_sleep(0.05)`)));
}

/** The stored credentials column as Postgres sees it, so a JSON `null` cannot pass for SQL NULL. */
async function storedCredentialsAreSqlNull(): Promise<boolean[]> {
	const result = await getDb().execute<{ is_null: boolean }>(
		sql`SELECT credentials IS NULL AS is_null FROM local_inference_pairings`
	);
	return [...result].map((r) => r.is_null);
}

describe.sequential("local inference pairings (CUR-4110)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("accepts only 32-128 URL-safe characters as a pairing id, so a guessable id cannot reach the poll", () => {
		expect(isValidPairingId("x".repeat(32))).toBe(true);
		expect(isValidPairingId("x".repeat(128))).toBe(true);
		expect(isValidPairingId("x".repeat(31))).toBe(false);
		expect(isValidPairingId("x".repeat(129))).toBe(false);
		expect(isValidPairingId("x".repeat(31) + "/")).toBe(false);
		expect(isValidPairingId("")).toBe(false);
	});

	it("the poll returns nothing before the visit and while the visit is still provisioning", async () => {
		const { userId } = await createTestUser();
		expect(await collectPairing(PAIRING_ID)).toBeNull();
		expect(await claimPairing(userId, PAIRING_ID)).toEqual({ status: "claimed" });
		expect(await collectPairing(PAIRING_ID)).toBeNull();
	});

	it("hands the parked credentials to the first poll only, and leaves SQL NULL in the table after", async () => {
		const { userId } = await createTestUser();
		const endpoint = await managedEndpointFor(userId);
		await claimPairing(userId, PAIRING_ID);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));
		expect(await storedCredentialsAreSqlNull()).toEqual([false]);

		expect(await collectPairing(PAIRING_ID)).toEqual(credentialsFor(endpoint.id));
		expect(await collectPairing(PAIRING_ID)).toBeNull();
		expect(await storedCredentialsAreSqlNull()).toEqual([true]);
	});

	it("two polls racing for the same pairing get the credentials once between them", async () => {
		const { userId } = await createTestUser();
		const endpoint = await managedEndpointFor(userId);
		await claimPairing(userId, PAIRING_ID);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));

		await warmPool();
		const results = await Promise.all(Array.from({ length: 5 }, () => collectPairing(PAIRING_ID)));
		expect(results.filter((r) => r !== null)).toHaveLength(1);
	});

	it("only one of several racing visits claims the id, so only one provisions a device", async () => {
		const { userId } = await createTestUser();
		await warmPool();
		const results = await Promise.all(Array.from({ length: 5 }, () => claimPairing(userId, PAIRING_ID)));
		expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
		expect(results.filter((r) => r.status === "already-claimed")).toHaveLength(4);
	});

	it("a revisit after the CLI collected is already-claimed, not a second provision", async () => {
		const { userId } = await createTestUser();
		const endpoint = await managedEndpointFor(userId);
		await claimPairing(userId, PAIRING_ID);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));
		await collectPairing(PAIRING_ID);

		expect(await claimPairing(userId, PAIRING_ID)).toEqual({ status: "already-claimed", completed: true });
	});

	it("another account visiting an id someone already claimed is refused and learns nothing", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		await claimPairing(owner.userId, PAIRING_ID);

		expect(await claimPairing(other.userId, PAIRING_ID)).toEqual({ status: "taken" });
	});

	it("completing as another account parks nothing on the owner's claim", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const endpoint = await managedEndpointFor(other.userId);
		await claimPairing(owner.userId, PAIRING_ID);
		await completePairing(other.userId, PAIRING_ID, credentialsFor(endpoint.id));

		expect(await collectPairing(PAIRING_ID)).toBeNull();
	});

	it("a failed provision releases the claim so the same link can be retried, but never a completed one", async () => {
		const { userId } = await createTestUser();
		await claimPairing(userId, PAIRING_ID);
		await releasePairing(userId, PAIRING_ID);
		expect(await claimPairing(userId, PAIRING_ID)).toEqual({ status: "claimed" });

		const endpoint = await managedEndpointFor(userId);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));
		await releasePairing(userId, PAIRING_ID);
		expect(await collectPairing(PAIRING_ID)).toEqual(credentialsFor(endpoint.id));
	});

	it("an expired pairing is never handed out, can be reclaimed, and the daily sweep deletes it", async () => {
		const { userId } = await createTestUser();
		const endpoint = await managedEndpointFor(userId);
		// Claimed 11 minutes ago: past the 10-minute PAIRING_TTL_MS.
		const claimedAt = new Date(Date.now() - 11 * 60 * 1000);
		await claimPairing(userId, PAIRING_ID, claimedAt);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));

		expect(await collectPairing(PAIRING_ID)).toBeNull();
		const counts = await cleanupExpired();
		expect(counts.localInferencePairings).toBe(1);
		expect(await storedCredentialsAreSqlNull()).toEqual([]);

		await claimPairing(userId, PAIRING_ID, claimedAt);
		expect(await claimPairing(userId, PAIRING_ID)).toEqual({ status: "claimed" });
	});

	it("deleting the endpoint before the CLI collects drops the pairing and its secret with it", async () => {
		const { userId } = await createTestUser();
		const endpoint = await managedEndpointFor(userId);
		await claimPairing(userId, PAIRING_ID);
		await completePairing(userId, PAIRING_ID, credentialsFor(endpoint.id));
		await getDb().execute(sql`DELETE FROM local_inference_endpoints WHERE id = ${endpoint.id}`);

		expect(await collectPairing(PAIRING_ID)).toBeNull();
		expect(await storedCredentialsAreSqlNull()).toEqual([]);
	});

	describe("the daily sweep of pairings nobody collected", () => {
		const EXPIRED = () => new Date(Date.now() - 11 * 60 * 1000);
		const config = (siteId: number) => ({ provider: "pangolin" as const, siteId, niceId: `n${siteId}`, resourceId: String(siteId) });

		/** A pairing claimed at `claimedAt`, whose visit provisioned an endpoint with Pangolin site `siteId`. */
		async function approvedPairing(userId: string, pairingId: string, siteId: number, claimedAt = EXPIRED()) {
			const endpoint = await createLocalEndpoint({
				userId,
				label: `box-${siteId}`,
				baseUrl: `https://box-${siteId}.example/v1`,
				kind: "managed",
				managedConfig: config(siteId),
			});
			await claimPairing(userId, pairingId, claimedAt);
			await completePairing(userId, pairingId, credentialsFor(endpoint.id));
			return endpoint;
		}

		const revokeOk = () => vi.fn(async () => true);

		it("revokes and removes the endpoint of an expired pairing the CLI never collected, taking the pairing with it", async () => {
			const { userId } = await createTestUser();
			await approvedPairing(userId, PAIRING_ID, 41);
			const revoke = revokeOk();

			expect(await sweepUncollectedPairings(new Date(), { revoke })).toEqual({
				endpointsRemoved: 1,
				revokeFailures: 0,
				errors: 0,
			});
			expect(revoke).toHaveBeenCalledWith(config(41), expect.any(String));
			expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
			expect(await storedCredentialsAreSqlNull()).toEqual([]);
		});

		it("never touches the endpoint of a collected pairing, even long after it expired, since a device is using it", async () => {
			const { userId } = await createTestUser();
			await approvedPairing(userId, PAIRING_ID, 42, new Date());
			await collectPairing(PAIRING_ID);
			const revoke = revokeOk();

			const later = new Date(Date.now() + 60 * 60 * 1000);
			expect((await sweepUncollectedPairings(later, { revoke })).endpointsRemoved).toBe(0);
			expect(revoke).not.toHaveBeenCalled();
			expect(await listLocalEndpointsForUserId(userId)).toHaveLength(1);
		});

		it("leaves an uncollected pairing alone until it expires, since the CLI may still be polling", async () => {
			const { userId } = await createTestUser();
			await approvedPairing(userId, PAIRING_ID, 43, new Date());

			expect((await sweepUncollectedPairings(new Date(), { revoke: revokeOk() })).endpointsRemoved).toBe(0);
			expect(await listLocalEndpointsForUserId(userId)).toHaveLength(1);
		});

		it("still removes the endpoint when Pangolin can't be reached, and counts the failed revoke", async () => {
			const { userId } = await createTestUser();
			await approvedPairing(userId, PAIRING_ID, 44);

			const result = await sweepUncollectedPairings(new Date(), { revoke: vi.fn(async () => false) });
			expect(result).toEqual({ endpointsRemoved: 1, revokeFailures: 1, errors: 0 });
			expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
		});

		it("removes at most `limit` per run, oldest first, leaving the rest for the next run", async () => {
			const { userId } = await createTestUser();
			const base = Date.now() - 60 * 60 * 1000;
			await approvedPairing(userId, "a".repeat(40), 51, new Date(base));
			await approvedPairing(userId, "b".repeat(40), 52, new Date(base + 1000));
			await approvedPairing(userId, "c".repeat(40), 53, new Date(base + 2000));

			expect((await sweepUncollectedPairings(new Date(), { revoke: revokeOk(), limit: 2 })).endpointsRemoved).toBe(2);
			expect((await listLocalEndpointsForUserId(userId)).map((e) => e.label)).toEqual(["box-53"]);
		});

		it("an expired claim whose visit never provisioned has no endpoint to remove; the TTL sweep deletes it", async () => {
			const { userId } = await createTestUser();
			await claimPairing(userId, PAIRING_ID, EXPIRED());

			expect((await sweepUncollectedPairings(new Date(), { revoke: revokeOk() })).endpointsRemoved).toBe(0);
			expect((await cleanupExpired()).localInferencePairings).toBe(1);
		});
	});
});
