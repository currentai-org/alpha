import { describe, it, expect, vi, beforeEach } from "vitest";

// Stateful fake of the SyftHub SDK client. setTokens/getTokens model the JWT-token slot the SDK reads
// to forward the aggregator's MPP `user_token`; we inject the PAT there (see syftClient.ts).
const h = vi.hoisted(() => {
	const setTokens = vi.fn();
	const logWarn = vi.fn();
	const constructed: FakeClient[] = [];
	class FakeClient {
		opts: Record<string, unknown>;
		_tokens: { accessToken: string; refreshToken: string; tokenType: string } | null = null;
		setTokens = (t: { accessToken: string; refreshToken: string; tokenType: string }) => {
			this._tokens = t;
			setTokens(t);
		};
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			constructed.push(this);
		}
		getTokens() {
			return this._tokens;
		}
	}
	return { setTokens, logWarn, constructed, FakeClient, config: {} as Record<string, unknown> };
});
const { logWarn } = h;

vi.mock("@syfthub/sdk", () => ({ SyftHubClient: h.FakeClient }));
vi.mock("./env", () => ({ syft: () => h.config }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: h.logWarn } }));

import { getSyftClient, syftClientBuildKey } from "./syftClient";

const latest = () => h.constructed[h.constructed.length - 1];

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(h.config)) {
		delete h.config[k];
	}
});

describe("getSyftClient", () => {
	// Contract, not just behavior (CUR-77): null is the fail-open signal — callers drop the federated
	// path and answer normally. An unconfigured token must degrade silently, never throw into a turn.
	// A null client and a real "queried, found nothing" result must be
	// distinguishable in the logs — every caller (syftSources.ts, syftCatalog.ts) silently no-ops.
	// Asserted here, on the FIRST call the missing-token branch ever executes in this file's test
	// order — warnedUnconfigured is module-level state, so a later repeat of this scenario would not
	// re-warn (proven in the next test) and would falsely read as "no warning happened". (CUR-878)
	it("returns null when no API token is configured, warning once (fail-open: callers answer without federated RAG)", () => {
		Object.assign(h.config, { token: "", baseUrl: "http://hub" });
		expect(getSyftClient()).toBeNull();
		expect(h.setTokens).not.toHaveBeenCalled();
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(logWarn.mock.calls[0][1]).toMatch(/token not configured/i);
		expect(logWarn.mock.calls[0][0]).toMatchObject({ baseUrl: "http://hub" });
	});

	it("does not warn again on a repeat call in the same process — a static config fact, not a per-turn event", () => {
		Object.assign(h.config, { token: "", baseUrl: "http://hub" });
		getSyftClient();
		getSyftClient();
		expect(logWarn).not.toHaveBeenCalled(); // already warned by the previous test's first call
	});

	it("builds a client and injects the PAT as the user_token (accessToken slot)", () => {
		Object.assign(h.config, { token: "tok-1", baseUrl: "http://hub" });
		const c = getSyftClient();
		expect(c).toBe(latest());
		expect(latest().opts).toEqual({ baseUrl: "http://hub", apiToken: "tok-1" });
		expect(h.setTokens).toHaveBeenCalledWith({
			accessToken: "tok-1",
			refreshToken: "tok-1",
			tokenType: "bearer",
		});
		expect(c?.getTokens()).not.toBeNull(); // user_token will be forwarded to the aggregator
	});

	it("memoizes: a repeat call reuses the client and does not re-inject", () => {
		Object.assign(h.config, { token: "tok-memo", baseUrl: "http://hub" });
		const a = getSyftClient();
		const b = getSyftClient();
		expect(b).toBe(a);
		expect(h.setTokens).toHaveBeenCalledTimes(1); // tokens already present → no re-inject
	});

	it("rebuilds (and re-injects) when the token changes, bumping the build key", () => {
		Object.assign(h.config, { token: "tok-a", baseUrl: "http://hub" });
		const a = getSyftClient();
		const keyA = syftClientBuildKey();
		h.config.token = "tok-b";
		const b = getSyftClient();
		expect(b).not.toBe(a);
		expect(syftClientBuildKey()).not.toBe(keyA);
		expect(h.setTokens).toHaveBeenLastCalledWith({
			accessToken: "tok-b",
			refreshToken: "tok-b",
			tokenType: "bearer",
		});
	});

	it("self-heals: re-injects the PAT if the SDK cleared its tokens (e.g. a failed refresh)", () => {
		Object.assign(h.config, { token: "tok-heal", baseUrl: "http://hub" });
		const c = getSyftClient();
		expect(h.setTokens).toHaveBeenCalledTimes(1);

		// Simulate the SDK clearing tokens on a 401-triggered refresh failure.
		latest()._tokens = null;
		const again = getSyftClient();
		expect(again).toBe(c); // same client (no rebuild)
		expect(h.setTokens).toHaveBeenCalledTimes(2); // but the user_token was re-asserted
		expect(again?.getTokens()).not.toBeNull();
	});
});
