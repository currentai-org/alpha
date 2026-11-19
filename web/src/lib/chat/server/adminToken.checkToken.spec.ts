/**
 * checkToken grants admin to a session on the exact ADMIN_TOKEN only. The compare is
 * constant-time over HMAC digests; what a test can pin is that near misses are refused, the exact
 * token grants, and the grant lands on that session alone.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/config", () => ({
	config: { ADMIN_TOKEN: "admin-secret-token", ADMIN_CLI_LOGIN: "true" },
}));

import { adminTokenManager } from "$lib/chat/server/adminToken";

describe("adminTokenManager.checkToken", () => {
	it.each([
		["an empty token", ""],
		["a wrong token", "not-the-token"],
		["a prefix of the token", "admin-secret-toke"],
		["the token with a trailing character", "admin-secret-tokenx"],
	])("refuses %s and grants nothing", async (_label, token) => {
		expect(await adminTokenManager.checkToken(token, "session-wrong")).toBe(false);
		expect(adminTokenManager.isAdmin("session-wrong")).toBe(false);
	});

	it("grants admin to that session for the exact token, and to no other session", async () => {
		expect(await adminTokenManager.checkToken("admin-secret-token", "session-right")).toBe(true);
		expect(adminTokenManager.isAdmin("session-right")).toBe(true);
		expect(adminTokenManager.isAdmin("session-other")).toBe(false);
	});
});
