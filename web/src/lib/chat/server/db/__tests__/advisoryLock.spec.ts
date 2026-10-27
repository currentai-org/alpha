/**
 * An owner's first sealed write makes their key under this lock, so two instances writing
 * for one owner at once cannot mint two keys. Run against the real database with a pool of several
 * connections, because with the deployed pool of one, a second caller waits for the connection and the
 * test would pass whether the lock held or not. (CUR-4116)
 */
process.env.PG_POOL_MAX = "4";

import { describe, expect, it } from "vitest";
import { withAdvisoryLock } from "$lib/chat/server/db/advisoryLock";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withAdvisoryLock", () => {
	it("never lets two holders of one name run at once, while a different name runs alongside", async () => {
		const inside = new Map<string, number>();
		const most = new Map<string, number>();
		let mostOverall = 0;
		const hold = (name: string) =>
			withAdvisoryLock(name, async () => {
				inside.set(name, (inside.get(name) ?? 0) + 1);
				most.set(name, Math.max(most.get(name) ?? 0, inside.get(name)!));
				mostOverall = Math.max(mostOverall, [...inside.values()].reduce((a, b) => a + b, 0));
				await pause(150);
				inside.set(name, inside.get(name)! - 1);
			});
		await Promise.all([hold("custodial-key:users:a"), hold("custodial-key:users:a"), hold("custodial-key:users:b")]);

		expect(most.get("custodial-key:users:a")).toBe(1);
		expect(mostOverall).toBe(2);
	});

	it("releases the lock when the holder throws, so the next caller is not stuck behind it", async () => {
		await expect(withAdvisoryLock("custodial-key:users:c", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await expect(withAdvisoryLock("custodial-key:users:c", async () => "next")).resolves.toBe("next");
	});
});
