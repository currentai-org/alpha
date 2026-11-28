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

const { refreshOAuthRow, tokensDue } = await import("./oauthConnect");
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
