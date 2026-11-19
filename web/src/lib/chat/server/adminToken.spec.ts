/**
 * Security coverage for the durable admin-proof cookie. The grant must survive across serverless
 * instances (the reason this exists — the in-memory adminSessions set does not), which means it's a
 * stateless HMAC bound to the sessionId. The invariants pinned here are the ones an attacker would
 * probe: the proof is deterministic (so it verifies), it's bound to ONE session (so it can't be
 * replayed against another), and empty inputs never validate. These hold regardless of whether the
 * feature is `enabled` in this env, so they're deterministic offline.
 */
import { describe, expect, it } from "vitest";
import { adminTokenManager } from "$lib/chat/server/adminToken";

describe("admin proof (instance-independent admin grant)", () => {
	it("makeProof is a deterministic HMAC-SHA256 hex digest for a session", async () => {
		const a = await adminTokenManager.makeProof("session-abc");
		const b = await adminTokenManager.makeProof("session-abc");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("binds the proof to the sessionId — different sessions get different proofs", async () => {
		const proofA = await adminTokenManager.makeProof("session-A");
		const proofB = await adminTokenManager.makeProof("session-B");
		expect(proofA).not.toBe(proofB);
	});

	it("verifyProof rejects a proof minted for a different session (replay protection)", async () => {
		const proofForA = await adminTokenManager.makeProof("session-A");
		expect(await adminTokenManager.verifyProof(proofForA, "session-B")).toBe(false);
	});

	it("verifyProof rejects missing proof or sessionId", async () => {
		expect(await adminTokenManager.verifyProof(undefined, "session-A")).toBe(false);
		expect(await adminTokenManager.verifyProof("deadbeef", undefined)).toBe(false);
		expect(await adminTokenManager.verifyProof(undefined, undefined)).toBe(false);
	});

	it("verifyProof rejects a malformed/garbage proof for a real session", async () => {
		expect(await adminTokenManager.verifyProof("not-a-real-proof", "session-A")).toBe(false);
	});
});
