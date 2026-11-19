/**
 * The cleanup cron's bearer check, with the database work replaced: the route deletes rows,
 * so only the exact `Bearer ${CRON_SECRET}` header may run it. The compare is constant-time over HMAC
 * digests; what a test can pin is that a near miss of any shape is refused and the real one runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: { CRON_SECRET: "cron-secret" } }));
const cleanupExpired = vi.hoisted(() => vi.fn(async () => ({ conversations: 0 })));
vi.mock("$lib/chat/server/db/cleanup", () => ({ cleanupExpired }));
vi.mock("$lib/chat/server/managedInference/sweepUncollectedPairings", () => ({
	sweepUncollectedPairings: vi.fn(async () => ({ endpointsRemoved: 0, revokeFailures: 0, errors: 0 })),
}));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({
	sweepExpiredGuestFiles: vi.fn(async () => ({ deleted: 0, failed: 0, undated: 0 })),
}));

import { GET } from "./+server";

function runCron(authorization?: string) {
	const headers = authorization !== undefined ? { authorization } : undefined;
	return GET({ request: new Request("http://localhost/chat/api/cleanup", { headers }) } as never);
}

describe("cleanup cron bearer check", () => {
	beforeEach(() => cleanupExpired.mockClear());

	it.each([
		["no header", undefined],
		["an empty header", ""],
		["a wrong secret", "Bearer wrong-secret"],
		["a prefix of the secret", "Bearer cron-secre"],
		["the secret with a trailing character", "Bearer cron-secretx"],
		["the bare secret with no scheme", "cron-secret"],
	])("answers 401 and deletes nothing for %s", async (_label, header) => {
		const res = await runCron(header);
		expect(res.status).toBe(401);
		expect(cleanupExpired).not.toHaveBeenCalled();
	});

	it("runs the cleanup for the exact bearer", async () => {
		const res = await runCron("Bearer cron-secret");
		expect(res.status).toBe(200);
		expect(cleanupExpired).toHaveBeenCalledTimes(1);
	});
});
