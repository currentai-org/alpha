// The person's per-tool choice from Settings → Connectors, applied by the kit. Run against the
// e2e stub server (e2eStub.ts) through the real SDK client: set_setting has no annotations, so it is a
// write tool; get_setting is marked read-only. `connect` is counted, so "did not run" is read off whether
// the server was reached at all, not off our own outcome label. (CUR-3984)
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({
	// mcp-servers on for every test here: the flag's own gate is CUR-3026's spec.
	flagEnabledOr: () => true,
	ensureFlagsPolled: async () => {},
}));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));

const { stubMcpServer } = await import("./e2eStub");
const { connectServer, listServerTools, resetServerToolsCache } = await import("./serverTools");
const { mcpServersKit } = await import("./serversKit");
const { mcpServersKitForTurn, mcpToolsClause } = await import("./turnKit");
const { settingsSchema } = await import("$lib/chat/server/settingsSchema");
const { z } = await import("zod");
const { fakeConfirm } = await import("./testFixtures");
type McpToolPolicy = import("$lib/chat/mcpToolPolicy").McpToolPolicy;

afterEach(() => resetServerToolsCache());

const WRITE = "stub__set_setting";
const READ = "stub__get_setting";
const call = (id: string, name: string, args: object = {}) => ({ id, name, arguments: JSON.stringify(args) });
const writeCall = (id: string) => call(id, WRITE, { name: "accent_color", value: "orange" });

async function kitWith(policies: Record<string, McpToolPolicy> | undefined, answer?: string) {
	const servers = [stubMcpServer()];
	const tools = await listServerTools(servers);
	const confirm = fakeConfirm(() => answer);
	let connects = 0;
	const kit = mcpServersKit({
		tools,
		servers,
		confirm,
		...(policies ? { policies } : {}),
		connect: (s, ms) => {
			connects++;
			return connectServer(s, ms);
		},
		sleep: async () => {},
	});
	return { kit, confirm, connects: () => connects };
}

async function drain(kit: Awaited<ReturnType<typeof kitWith>>["kit"], calls: ReturnType<typeof call>[]) {
	const frames = [];
	for await (const f of kit.beforeRun(calls)) frames.push(f);
	return frames;
}

describe("Settings → Connectors choices in the MCP servers kit (CUR-3984)", () => {
	it("block: the tool is not offered, a call naming it never reaches the server, and the model is told the person turned it off", async () => {
		const { kit, confirm, connects } = await kitWith({ [WRITE]: "block" }, "accept");
		const offered = kit.definitions.map((d) => d.function.name);
		expect(offered).not.toContain(WRITE);
		expect(offered).toContain(READ);
		expect(kit.blocked).toEqual([WRITE]);

		const c = writeCall("b1");
		expect(await drain(kit, [c])).toEqual([]);
		const res = await kit.run(c);
		expect(res.mcpCall?.outcome).toBe("blocked");
		expect(res.content).toContain("turned this tool off in Settings → Connectors");
		expect(confirm.opened).toEqual([]);
		expect(connects()).toBe(0);
	});

	it("block on a read-only tool: it does not run either, even though it would never ask", async () => {
		const { kit, connects } = await kitWith({ [READ]: "block" });
		const res = await kit.run(call("b2", READ, { name: "accent_color" }));
		expect(res.mcpCall?.outcome).toBe("blocked");
		expect(connects()).toBe(0);
	});

	it("allow: a write tool runs with no confirmation card", async () => {
		// The store would say no if it were asked: a pass proves it was never asked.
		const { kit, confirm, connects } = await kitWith({ [WRITE]: "allow" }, "decline");
		const c = writeCall("a1");
		expect(await drain(kit, [c])).toEqual([]);
		const res = await kit.run(c);
		expect(confirm.opened).toEqual([]);
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.content).toContain("accent_color changed from teal to orange");
		expect(connects()).toBe(1);
	});

	it("ask: a write tool still shows the card and does not run when the person declines", async () => {
		const { kit, confirm, connects } = await kitWith({ [WRITE]: "ask" }, "decline");
		const c = writeCall("k1");
		const frames = await drain(kit, [c]);
		expect(frames.some((f) => f.agentConfirm)).toBe(true);
		expect(confirm.opened).toEqual(["set_setting"]);
		expect((await kit.run(c)).mcpCall?.outcome).toBe("declined");
		expect(connects()).toBe(0);
	});

	it("no choice saved is ask, never a silent allow: the write tool shows the card", async () => {
		const { kit, confirm } = await kitWith(undefined, "decline");
		const c = writeCall("d1");
		await drain(kit, [c]);
		expect(confirm.opened).toEqual(["set_setting"]);
		expect((await kit.run(c)).mcpCall?.outcome).toBe("declined");
	});

	it("an unknown stored value is treated as ask, not as allow", async () => {
		const { kit, confirm } = await kitWith({ [WRITE]: "yes-please" as McpToolPolicy }, "decline");
		await drain(kit, [writeCall("u1")]);
		expect(confirm.opened).toEqual(["set_setting"]);
	});
});

describe("the turn reads the person's choices (CUR-3984)", () => {
	const ctx = { conv: { _id: {} as never }, faultInjection: "mcp_stub_server" as const, locals: {} as App.Locals };

	it("passes the locals it was given to the policy read, and applies what comes back", async () => {
		const seen: unknown[] = [];
		const kit = await mcpServersKitForTurn(ctx, async (locals) => {
			seen.push(locals);
			return { [WRITE]: "block" };
		});
		expect(seen).toEqual([ctx.locals]);
		expect(kit?.definitions.map((d) => d.function.name)).not.toContain(WRITE);
		expect(mcpToolsClause(kit!)).toContain(`turned these tools off, so they are not available: ${WRITE}`);
	});

	it("offers no kit when the person turned every tool off, rather than an empty tool list", async () => {
		const kit = await mcpServersKitForTurn(ctx, async () => ({
			stub__get_setting: "block",
			stub__set_setting: "block",
			stub__get_admin_lock: "block",
		}));
		expect(kit).toBeUndefined();
	});

	it("with nothing turned off the clause carries no turned-off note; a blocked list only appends one", () => {
		const clause = mcpToolsClause({ blocked: [] });
		expect(clause).not.toContain("turned these tools off");
		expect(mcpToolsClause({ blocked: ["x__y"] }).startsWith(clause)).toBe(true);
	});
});

describe("mcpToolPolicies in the settings body (CUR-3984)", () => {
	const schema = settingsSchema(z.string());

	it("accepts allow, ask and block keyed by server__tool names", () => {
		const parsed = schema.parse({ mcpToolPolicies: { [WRITE]: "allow", [READ]: "block", x__y: "ask" } });
		expect(parsed.mcpToolPolicies).toEqual({ [WRITE]: "allow", [READ]: "block", x__y: "ask" });
	});

	it("rejects a value outside the three choices", () => {
		expect(() => schema.parse({ mcpToolPolicies: { [WRITE]: "always" } })).toThrow();
	});

	it("rejects a key that could be a Mongo operator or a dotted path", () => {
		expect(() => schema.parse({ mcpToolPolicies: { $set: "allow" } })).toThrow();
		expect(() => schema.parse({ mcpToolPolicies: { "a.b": "allow" } })).toThrow();
	});
});
