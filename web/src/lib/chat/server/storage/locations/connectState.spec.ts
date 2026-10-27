import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/config", () => ({ config: {} }));

import { checkConnectState, CONNECT_TTL_SECONDS, sealConnectState } from "./connectState";
import { seal } from "./sealedSecret";

const SECRET = "connect-state-test-secret";
const NOW = 1_800_000_000_000;

function minted(accountId = "acct-1", state = "state-abc") {
	return sealConnectState({ state, verifier: "verifier-xyz", accountId }, SECRET, NOW);
}

describe("checkConnectState", () => {
	it("hands back the verifier only when the cookie, the state and the account all match", () => {
		expect(checkConnectState(minted(), "state-abc", "acct-1", SECRET, NOW + 1000)).toEqual({
			ok: true,
			verifier: "verifier-xyz",
		});
	});

	it("refuses a callback whose state differs from the one the connect route minted (forged state)", () => {
		expect(checkConnectState(minted(), "state-forged", "acct-1", SECRET, NOW)).toEqual({
			ok: false,
			reason: "state-mismatch",
		});
	});

	it("refuses a callback with no cookie, so a code cannot be finished without having started here", () => {
		expect(checkConnectState(undefined, "state-abc", "acct-1", SECRET, NOW)).toEqual({ ok: false, reason: "missing" });
	});

	it("refuses a callback with no state parameter", () => {
		expect(checkConnectState(minted(), null, "acct-1", SECRET, NOW)).toEqual({ ok: false, reason: "missing" });
	});

	it("refuses a code that comes back to a different signed-in account than the one that started it", () => {
		expect(checkConnectState(minted("acct-1"), "state-abc", "acct-2", SECRET, NOW)).toEqual({
			ok: false,
			reason: "other-account",
		});
	});

	it("refuses a connect older than its TTL", () => {
		expect(checkConnectState(minted(), "state-abc", "acct-1", SECRET, NOW + CONNECT_TTL_SECONDS * 1000)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it("refuses a cookie sealed under another secret, or one that was hand-written", () => {
		const other = sealConnectState({ state: "state-abc", verifier: "v", accountId: "acct-1" }, "other-secret", NOW);
		expect(checkConnectState(other, "state-abc", "acct-1", SECRET, NOW)).toEqual({ ok: false, reason: "tampered" });
		const handWritten = JSON.stringify({ state: "state-abc", verifier: "v", accountId: "acct-1", expiresAt: NOW * 2 });
		expect(checkConnectState(handWritten, "state-abc", "acct-1", SECRET, NOW)).toEqual({ ok: false, reason: "tampered" });
		expect(checkConnectState(seal("not json", SECRET), "state-abc", "acct-1", SECRET, NOW)).toEqual({
			ok: false,
			reason: "tampered",
		});
	});
});

describe("the bucket a person named on Connect", () => {
	it("comes back from the sealed cookie to the callback, and is absent when they named none", () => {
		const named = sealConnectState({ state: "state-abc", verifier: "v", accountId: "acct-1", bucket: "photos" }, SECRET, NOW);
		expect(checkConnectState(named, "state-abc", "acct-1", SECRET, NOW)).toEqual({ ok: true, verifier: "v", bucket: "photos" });
		expect(checkConnectState(minted(), "state-abc", "acct-1", SECRET, NOW)).toEqual({ ok: true, verifier: "verifier-xyz" });
	});
});
