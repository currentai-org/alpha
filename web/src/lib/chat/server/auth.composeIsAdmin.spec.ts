/**
 * composeIsAdmin is the single OR-composition every authenticateRequest() branch calls, so every
 * branch applies the durable proof-cookie escalation the same way.
 * Mock adminTokenManager so each term of the OR can be driven independently — the real instance is
 * disabled in this env (ADMIN_CLI_LOGIN unset, see adminToken.spec.ts's own comment), which would
 * collapse isAdmin()/verifyProof() to always-false and hide the composition entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isAdminMock, verifyProofMock } = vi.hoisted(() => ({
	isAdminMock: vi.fn(),
	verifyProofMock: vi.fn(),
}));
vi.mock("$lib/chat/server/adminToken", () => ({
	adminTokenManager: { isAdmin: isAdminMock, verifyProof: verifyProofMock },
	ADMIN_PROOF_COOKIE: "admin-proof",
}));

import { composeIsAdmin } from "./auth";

describe("composeIsAdmin — the shape every authenticateRequest() branch must agree on", () => {
	beforeEach(() => {
		isAdminMock.mockReset().mockReturnValue(false);
		verifyProofMock.mockReset().mockResolvedValue(false);
	});

	it("true when the stored user record says admin, short-circuiting both token checks", async () => {
		expect(await composeIsAdmin(true, "s1", undefined)).toBe(true);
		expect(isAdminMock).not.toHaveBeenCalled();
		expect(verifyProofMock).not.toHaveBeenCalled();
	});

	it("true on a same-instance admin-token grant alone, without needing the proof cookie", async () => {
		isAdminMock.mockReturnValue(true);
		expect(await composeIsAdmin(false, "s1", undefined)).toBe(true);
		expect(verifyProofMock).not.toHaveBeenCalled();
	});

	it("true on the durable cross-instance proof cookie alone — the escalation 3 of 5 branches used to skip", async () => {
		verifyProofMock.mockResolvedValue(true);
		expect(await composeIsAdmin(false, "s1", "proof-value")).toBe(true);
		expect(verifyProofMock).toHaveBeenCalledWith("proof-value", "s1");
	});

	it("false when the stored flag is undefined — the email/trusted-header branch's synthetic user has no isAdmin field at all — and neither token check passes", async () => {
		expect(await composeIsAdmin(undefined, "s1", undefined)).toBe(false);
	});

	it("false when nothing agrees, including a stale/invalid proof cookie", async () => {
		expect(await composeIsAdmin(false, "s1", "stale-proof")).toBe(false);
	});
});
