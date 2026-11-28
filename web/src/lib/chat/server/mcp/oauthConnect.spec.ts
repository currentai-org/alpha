import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ result: "AUTHORIZED" as "AUTHORIZED" | "REDIRECT", throws: null as Error | null }));
const saved = vi.hoisted(() => [] as { id: string; update: Record<string, unknown> }[]);
vi.mock("$lib/chat/server/config", () => ({ config: { BETTER_AUTH_SECRET: "test-secret", PUBLIC_ORIGIN: "https://alpha.example" } }));
vi.mock("@modelcontextprotocol/client", () => ({
	discoverOAuthProtectedResourceMetadata: vi.fn(),
	auth: vi.fn(async (provider: { saveTokens: (t: unknown) => Promise<void> }) => {
		if (sdk.throws) throw sdk.throws;
		if (sdk.result === "AUTHORIZED") await provider.saveTokens({ access_token: "fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "r2" });
		return sdk.result;
	}),
}));
vi.mock("$lib/chat/server/db/userMcpServers", () => ({
	saveUserMcpServerOAuth: vi.fn(async (_userId: string, id: string, update: Record<string, unknown>) => void saved.push({ id, update })),
}));

const { oauthServerFetch, refreshOAuthRow, tokensDue } = await import("./oauthConnect");
const { auth } = await import("@modelcontextprotocol/client");
const { ssrfStrictFetch } = await import("$lib/chat/server/urlSafety");
const { openOAuthState, sealOAuthState } = await import("./oauthProvider");
type Row = import("$lib/chat/server/db/userMcpServers").UserMcpServerRow;

const NOW = 1_800_000_000_000;
function row(state: Parameters<typeof sealOAuthState>[0] | null, extra: Partial<Row> = {}): Row {
	return {
		id: "srv-1",
		userId: "user-1",
		name: "linear",
		url: "https://mcp.example/mcp",
		credential: null,
		authKind: "oauth",
		oauthState: state ? sealOAuthState(state, "test-secret") : null,
		needsReconnect: false,
		createdAt: new Date(NOW),
		...extra,
	};
}
const live = { access_token: "old", token_type: "Bearer", expires_in: 3600, refresh_token: "r1" };

beforeEach(() => {
	sdk.result = "AUTHORIZED";
	sdk.throws = null;
	saved.length = 0;
	vi.mocked(auth).mockClear();
});

describe("tokensDue", () => {
	it("is due inside the last minute of the stated lifetime, not before", () => {
		expect(tokensDue({ tokens: live, tokensSavedAt: NOW - 3_000_000 }, NOW)).toBe(false);
		expect(tokensDue({ tokens: live, tokensSavedAt: NOW - 3_560_000 }, NOW)).toBe(true);
	});
	it("is never due for tokens with no stated lifetime", () => {
		expect(tokensDue({ tokens: { access_token: "a", token_type: "Bearer" }, tokensSavedAt: 0 }, NOW)).toBe(false);
	});
});

describe("refreshOAuthRow", () => {
	it("leaves a live token alone and makes no call", async () => {
		const r = row({ tokens: live, tokensSavedAt: NOW - 60_000 });
		expect(await refreshOAuthRow(r, NOW)).toBe(r);
		expect(saved).toEqual([]);
	});

	it("refreshes an expired access token without the person reconnecting", async () => {
		const out = await refreshOAuthRow(row({ tokens: live, tokensSavedAt: NOW - 3_600_000 }), NOW);
		expect(out.needsReconnect).toBe(false);
		expect(openOAuthState(out.oauthState!, "test-secret").tokens?.access_token).toBe("fresh");
	});

	it("marks the server for reconnecting (and leaves it out) when the refresh is refused, never throwing into the turn", async () => {
		sdk.throws = new Error("invalid_grant");
		const out = await refreshOAuthRow(row({ tokens: live, tokensSavedAt: NOW - 3_600_000 }), NOW);
		expect(out.needsReconnect).toBe(true);
		expect(saved.at(-1)).toEqual({ id: "srv-1", update: { needsReconnect: true } });
	});

	it("marks the server for reconnecting when the refresh asks for consent again", async () => {
		sdk.result = "REDIRECT";
		expect((await refreshOAuthRow(row({ tokens: live, tokensSavedAt: NOW - 3_600_000 }), NOW)).needsReconnect).toBe(true);
	});

	it("marks a server that never finished signing in", async () => {
		expect((await refreshOAuthRow(row(null), NOW)).needsReconnect).toBe(true);
	});

	it("passes a bearer server through untouched", async () => {
		const r = row(null, { authKind: "bearer" });
		expect(await refreshOAuthRow(r, NOW)).toBe(r);
	});
});

describe("oauthServerFetch: a 401 from the server, at connect or at a tool call", () => {
	// The MCP server: refuses every token but the ones listed, and records what each request carried.
	function server(accepted: string[]) {
		const seen: string[] = [];
		const inner = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const bearer = new Headers(init?.headers).get("authorization") ?? "";
			seen.push(bearer);
			return new Response("{}", { status: accepted.some((t) => bearer === `Bearer ${t}`) ? 200 : 401 });
		});
		return { inner, seen };
	}
	const signedIn = () => row({ tokens: live, tokensSavedAt: NOW });
	const rpc = { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' };

	it("refreshes once, through the strict SSRF guard, and repeats the refused request with the new token", async () => {
		const { inner, seen } = server(["fresh"]);
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret" });
		const res = await fetch("https://mcp.example/mcp", rpc);
		expect(res.status).toBe(200);
		expect(seen).toEqual(["Bearer old", "Bearer fresh"]);
		expect(inner.mock.calls[1][1]?.body).toBe(rpc.body);
		expect(vi.mocked(auth)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(auth).mock.calls[0][1]).toMatchObject({ fetchFn: ssrfStrictFetch });
		// Later requests carry the new token, and the server stays in the turn.
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(200);
		expect(seen.at(-1)).toBe("Bearer fresh");
		expect(saved.some((s) => s.update.needsReconnect === true)).toBe(false);
	});

	it("refreshes only once when several requests are refused together", async () => {
		const { inner } = server(["fresh"]);
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret" });
		const results = await Promise.all([fetch("https://mcp.example/mcp", rpc), fetch("https://mcp.example/mcp", rpc)]);
		expect(results.map((r) => r.status)).toEqual([200, 200]);
		expect(vi.mocked(auth)).toHaveBeenCalledTimes(1);
	});

	it("marks the server for reconnecting when the refresh fails, and leaves it out of the rest of the turn", async () => {
		sdk.throws = new Error("invalid_grant");
		const { inner } = server([]);
		const leftOut: string[] = [];
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret", onReconnectNeeded: (id) => leftOut.push(id) });
		// The 401 goes back to the MCP client, which fails that request the way it fails any unreachable server.
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(401);
		expect(saved).toContainEqual({ id: "srv-1", update: { needsReconnect: true } });
		expect(leftOut).toEqual(["srv-1"]);
		await expect(fetch("https://mcp.example/mcp", rpc)).rejects.toThrow(/reconnecting/);
		expect(inner).toHaveBeenCalledTimes(1);
		expect(vi.mocked(auth)).toHaveBeenCalledTimes(1);
	});

	it("marks the server for reconnecting when the refresh asks for consent again", async () => {
		sdk.result = "REDIRECT";
		const { inner } = server([]);
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret" });
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(401);
		expect(saved).toContainEqual({ id: "srv-1", update: { needsReconnect: true } });
		await expect(fetch("https://mcp.example/mcp", rpc)).rejects.toThrow();
	});

	it("marks the server for reconnecting when it refuses the refreshed token too, without a second refresh", async () => {
		const { inner, seen } = server([]);
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret" });
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(401);
		expect(seen).toEqual(["Bearer old", "Bearer fresh"]);
		expect(vi.mocked(auth)).toHaveBeenCalledTimes(1);
		expect(saved).toContainEqual({ id: "srv-1", update: { needsReconnect: true } });
	});

	it("marks a server whose tokens carry no refresh token, without asking the authorization server", async () => {
		const { inner } = server([]);
		const noRefresh = row({ tokens: { access_token: "old", token_type: "Bearer" }, tokensSavedAt: NOW });
		const fetch = oauthServerFetch(noRefresh, "old", inner, { secret: "test-secret" });
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(401);
		expect(vi.mocked(auth)).not.toHaveBeenCalled();
		expect(saved).toContainEqual({ id: "srv-1", update: { needsReconnect: true } });
	});

	it("never throws into the turn when marking the server fails", async () => {
		sdk.throws = new Error("invalid_grant");
		const db = await import("$lib/chat/server/db/userMcpServers");
		vi.mocked(db.saveUserMcpServerOAuth).mockRejectedValueOnce(new Error("db down"));
		const { inner } = server([]);
		const fetch = oauthServerFetch(signedIn(), "old", inner, { secret: "test-secret" });
		expect((await fetch("https://mcp.example/mcp", rpc)).status).toBe(401);
	});
});
