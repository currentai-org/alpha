// A person's own MCP servers, added in Settings → Connectors. The token is sealed at rest,
// rides only to the server's own origin, and a server is offered only on its owner's turn. (CUR-4016)
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));
const cfg = vi.hoisted(() => ({ MCP_SERVERS: undefined as string | undefined, BETTER_AUTH_SECRET: "test-secret" }));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const { checkNewServer, sealServerToken, userServerConfigs, userMcpServersFor } = await import(
	"./userServers"
);
const { serversForRequest } = await import("./turnKit");
const { STUB_URL } = await import("./e2eStub");
const { seal } = await import("$lib/chat/server/storage/locations/sealedSecret");
type Row = import("$lib/chat/server/db/userMcpServers").UserMcpServerRow;

const SECRET = "test-secret";
const TOKEN = "tok_abc123";
const row = (over: Partial<Row> = {}): Row => ({
	id: "r1",
	userId: "u1",
	name: "notes",
	url: "https://notes.example.com/mcp",
	credential: sealServerToken(TOKEN, SECRET),
	createdAt: new Date(0),
	...over,
});
const input = (over: Partial<{ name: string; url: string; token: string }> = {}) => ({
	name: "Notes",
	url: "https://notes.example.com/mcp",
	token: "",
	...over,
});

describe("checkNewServer refuses what a turn could not safely use (CUR-4016)", () => {
	it("accepts a public https server, lower-cases its name, and keeps an empty token as none", () => {
		expect(checkNewServer(input(), [], 0)).toEqual({ ok: true, name: "notes", url: "https://notes.example.com/mcp", token: null });
	});

	it.each([
		["a name that cannot be a tool prefix", input({ name: "my notes!" })],
		["plain http", input({ url: "http://notes.example.com/mcp" })],
		["localhost", input({ url: "https://localhost/mcp" })],
		["a private IP", input({ url: "https://10.0.0.5/mcp" })],
		["a token with a space, which could carry a second header", input({ token: "abc\r\nX-Evil: 1" })],
	])("refuses %s", (_label, i) => {
		expect(checkNewServer(i, [], 0).ok).toBe(false);
	});

	it("refuses a name already in use, operator's or the person's own", () => {
		expect(checkNewServer(input(), ["notes"], 0)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
	});

	it("refuses a sixth server, past the five-server cap", () => {
		expect(checkNewServer(input(), [], 4).ok).toBe(true);
		expect(checkNewServer(input(), [], 5).ok).toBe(false);
	});
});

describe("the token is sealed at rest and sent only to the server's origin (CUR-4016)", () => {
	it("stores no readable copy of the token", () => {
		const sealed = sealServerToken(TOKEN, SECRET);
		expect(sealed).not.toContain(TOKEN);
		expect(sealed.startsWith("v1.")).toBe(true);
	});

	it("opens it into a bearer header on the server's own origin", async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const base = async (url: string | URL, init?: RequestInit) => {
			seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
			return new Response("{}", { status: 200 });
		};
		const [server] = userServerConfigs([row()], { secret: SECRET, baseFetch: base });
		expect(server.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
		await server.fetch("https://notes.example.com/mcp", { method: "POST", headers: server.headers });
		expect(seen).toEqual([{ url: "https://notes.example.com/mcp", auth: `Bearer ${TOKEN}` }]);
	});

	it("refuses a request or redirect to any other origin before anything is sent", async () => {
		let sent = 0;
		const base = async (_url: string | URL) => {
			sent++;
			return new Response(null, { status: 302, headers: { location: "https://evil.example.net/steal" } });
		};
		const [server] = userServerConfigs([row()], { secret: SECRET, baseFetch: base });
		await expect(server.fetch("https://evil.example.net/x", { headers: server.headers })).rejects.toThrow(/refused/);
		expect(sent).toBe(0);
		await expect(server.fetch("https://notes.example.com/mcp", { headers: server.headers })).rejects.toThrow(/refused/);
		expect(sent).toBe(1);
	});

	it("leaves a server out, rather than sending it tokenless, when its token no longer opens", () => {
		// Sealed under the storage-location info string: the same secret, a different key.
		const servers = userServerConfigs([row({ credential: seal(TOKEN, SECRET) })], { secret: SECRET });
		expect(servers).toEqual([]);
	});

	it("sends no Authorization header for a server added without a token", () => {
		expect(userServerConfigs([row({ credential: null })], { secret: SECRET })[0].headers).toEqual({});
	});
});

describe("a person's servers reach only their own turn (CUR-4016)", () => {
	it("reads the signed-in account's rows and no one else's", async () => {
		const list = vi.fn(async (userId: string) => [row({ userId })]);
		const servers = await userMcpServersFor({ user: { _id: { toString: () => "u1" } } } as App.Locals, null, list);
		expect(list).toHaveBeenCalledWith("u1");
		expect(list).toHaveBeenCalledTimes(1);
		expect(servers.map((s) => s.name)).toEqual(["notes"]);
	});

	it("gives a guest none and reads nothing", async () => {
		const list = vi.fn(async () => [row()]);
		expect(await userMcpServersFor({ sessionId: "guest" } as App.Locals, null, list)).toEqual([]);
		expect(list).not.toHaveBeenCalled();
	});

	it("falls back to the configured servers alone when the read fails", async () => {
		const list = vi.fn(async () => {
			throw new Error("db down");
		});
		expect(await userMcpServersFor({ user: { _id: "u1" } } as unknown as App.Locals, null, list)).toEqual([]);
	});
});

describe("serversForRequest puts own servers beside the operator's (CUR-4016)", () => {
	it("adds them after the configured ones, and drops one whose name an operator server holds", () => {
		cfg.MCP_SERVERS = JSON.stringify([{ name: "notes", url: "https://ops.example.com/mcp" }]);
		const own = userServerConfigs([row(), row({ id: "r2", name: "wiki", url: "https://wiki.example.com/mcp" })], { secret: SECRET });
		expect(serversForRequest(null, own).map((s) => [s.name, s.url])).toEqual([
			["notes", "https://ops.example.com/mcp"],
			["wiki", "https://wiki.example.com/mcp"],
		]);
		cfg.MCP_SERVERS = undefined;
	});

	it("does not add the e2e stub a second time when the person added it themselves", () => {
		const own = userServerConfigs([row({ name: "mine", url: STUB_URL, credential: null })], {
			faultInjection: "mcp_stub_server",
		});
		expect(serversForRequest("mcp_stub_server", own).map((s) => s.name)).toEqual(["mine"]);
		expect(serversForRequest("mcp_stub_server", []).map((s) => s.name)).toEqual(["stub"]);
	});
});
