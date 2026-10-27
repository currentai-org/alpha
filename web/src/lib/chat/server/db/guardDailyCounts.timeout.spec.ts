/**
 * The distress answer awaits its count, so a database that never answers must not hold it. The
 * contract: the count gives up at its deadline and resolves, and a write that rejects resolves too. (CUR-3915)
 */
import { describe, expect, it, vi } from "vitest";

let pending: Promise<unknown> = new Promise(() => {});

vi.mock("$lib/chat/server/db/client", () => ({
	getDb: () => ({
		insert: () => ({
			values: () => ({
				onConflictDoUpdate: () => pending,
			}),
		}),
	}),
}));

const { countGuardHitsSafe } = await import("./guardDailyCounts");

describe("countGuardHitsSafe deadline (CUR-3915)", () => {
	it("resolves at its deadline when the database never answers, so the distress answer is not held", async () => {
		pending = new Promise(() => {});
		const started = Date.now();
		await countGuardHitsSafe(["chat-block-self-harm-passive"], new Date(), 50);
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(40);
		expect(waited).toBeLessThan(1000);
	});

	it("resolves without throwing when the write rejects", async () => {
		pending = Promise.reject(new Error("db down"));
		await expect(countGuardHitsSafe(["chat-block-self-harm-passive"], new Date(), 50)).resolves.toBeUndefined();
	});
});
