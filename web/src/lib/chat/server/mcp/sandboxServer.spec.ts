// The conversation's sandbox on a native chat turn. The server config is checked for the
// headers agent-service keys the workdir on; the turn kit is run against a fixture speaking the real
// Streamable HTTP shape (answerMcpRequest). "Ran without a card" is read off whether the fixture was
// called, since our own outcome label is the thing under test. (CUR-4232)
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string) => flags.on.has(key),
	ensureFlagsPolled: async () => {},
}));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));

const { answerMcpRequest } = await import("./e2eStub");
const { originScopedFetch } = await import("./servers");
const { resetServerToolsCache } = await import("./serverTools");
const { mcpServersKitForTurn, mcpToolsClause } = await import("./turnKit");
const { sandboxServerFor, SANDBOX_CLAUSE } = await import("./sandboxServer");
const { deriveAgentSubject } = await import("$lib/chat/server/endpoints/agent/endpointAgent");
type McpServerConfig = import("./servers").McpServerConfig;

afterEach(() => {
	resetServerToolsCache();
	flags.on.clear();
});

const deps = { enabled: () => true, url: () => "https://agent.example.test", token: () => "tok" };
const locals = { sessionId: "visitor-1", user: { _id: "account-1" } } as unknown as App.Locals;

describe("sandboxServerFor", () => {
	it("names the account and the conversation, so the agent and chat share one workdir", () => {
		const s = sandboxServerFor("conv-9", locals, deps);
		expect(s?.url).toBe("https://agent.example.test/mcp/");
		expect(s?.headers).toEqual({
			authorization: "Bearer tok",
			"x-agent-subject": deriveAgentSubject("tok", "account-1"),
			// agent-service refuses a call that names no account kind. (CUR-4402)
			"x-agent-account": "user",
			"x-agent-session": "conv-9",
		});
	});

	it("CUR-4400: offers nothing to a guest even with the flag on, since running code is for signed-in accounts", () => {
		expect(sandboxServerFor("conv-9", { sessionId: "visitor-1" } as App.Locals, deps)).toBeUndefined();
		expect(sandboxServerFor("conv-9", undefined, deps)).toBeUndefined();
	});

	it("offers nothing when the flag is off, the service is unset, or its address is not https", () => {
		expect(sandboxServerFor("conv-9", locals, { ...deps, enabled: () => false })).toBeUndefined();
		expect(sandboxServerFor("conv-9", locals, { ...deps, url: () => "" })).toBeUndefined();
		expect(sandboxServerFor("conv-9", locals, { ...deps, url: () => "http://agent.example.test" })).toBeUndefined();
	});

	it("reads the one-chat-sandbox flag when no gate is injected", () => {
		const { enabled: _, ...rest } = deps;
		expect(sandboxServerFor("conv-9", locals, rest)).toBeUndefined();
		flags.on.add("one-chat-sandbox");
		expect(sandboxServerFor("conv-9", locals, rest)).toBeDefined();
	});
});

/** A sandbox stand-in that records each tools/call it answers. */
function fixtureSandbox(): { server: McpServerConfig; calls: string[] } {
	const calls: string[] = [];
	const origin = "https://agent.example.test";
	const tools = [
		{ name: "run_code", description: "Run Python", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
		{ name: "list_files", description: "List", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	];
	const fetch = async (_url: string | URL, init?: RequestInit) => {
		const { status, payload } = answerMcpRequest(String(init?.body ?? "{}"), {
			serverName: "sandbox",
			tools,
			call: (name) => {
				calls.push(name);
				return { content: [{ type: "text", text: "exit code 0\nstdout:\n8\n" }] };
			},
		});
		return payload === undefined
			? new Response(null, { status })
			: new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
	};
	return {
		calls,
		server: { name: "sandbox", url: `${origin}/mcp/`, headers: {}, origin, fetch: originScopedFetch(origin, fetch) },
	};
}

const ctx = { conv: { _id: { toString: () => "conv-9" } as never }, locals };
const runCode = { id: "c1", name: "sandbox__run_code", arguments: JSON.stringify({ code: "print(8)" }) };

async function drain(gen: AsyncGenerator<unknown, void, void> | undefined) {
	if (gen) for await (const _ of gen);
}

describe("the turn kit with the sandbox", () => {
	it("is offered with mcp-servers off, and run_code runs with no card when the person chose nothing", async () => {
		const fx = fixtureSandbox();
		const kit = await mcpServersKitForTurn(ctx, async () => ({}), async () => [], {
			withSandbox: true,
			sandboxFor: () => fx.server,
		});
		expect(kit?.definitions.map((d) => d.function.name).sort()).toEqual(["sandbox__list_files", "sandbox__run_code"]);
		await drain(kit!.beforeRun([runCode]));
		const res = await kit!.run(runCode);
		expect(fx.calls).toEqual(["run_code"]);
		expect(res.mcpCall?.outcome).toBe("ok");
		// In place of a card, the trace carries the code and what it printed.
		expect(res.mcpCall?.input).toBe("print(8)");
		expect(res.mcpCall?.output).toContain("stdout:\n8");
		expect(mcpToolsClause(kit!)).toContain(SANDBOX_CLAUSE);
	});

	it("CUR-4578: sandbox_stub swaps the sandbox for the in-process stand-in, only where the sandbox is offered", async () => {
		const fx = fixtureSandbox();
		const stubbed = await mcpServersKitForTurn({ ...ctx, faultInjection: "sandbox_stub" }, async () => ({}), async () => [], {
			withSandbox: true,
			sandboxFor: () => fx.server,
		});
		const res = await stubbed!.run(runCode);
		expect(fx.calls).toEqual([]);
		expect(res.mcpCall).toMatchObject({ server: "sandbox", tool: "run_code", outcome: "ok" });
		expect(res.mcpCall?.output).toContain("1267650600228229401496703205376");
		// Not offered (a guest, the flag off): the fault adds nothing.
		const none = await mcpServersKitForTurn({ ...ctx, faultInjection: "sandbox_stub" }, async () => ({}), async () => [], {
			withSandbox: true,
			sandboxFor: () => undefined,
		});
		expect(none).toBeUndefined();
	});

	it("a person who set run_code to ask gets the card back, and without an answer it does not run", async () => {
		const fx = fixtureSandbox();
		const kit = await mcpServersKitForTurn(ctx, async () => ({ sandbox__run_code: "ask" }), async () => [], {
			withSandbox: true,
			sandboxFor: () => fx.server,
		});
		// The mocked database cannot open a card, which the kit treats as a no.
		await drain(kit!.beforeRun([runCode]));
		expect((await kit!.run(runCode)).mcpCall?.outcome).toBe("declined");
		expect(fx.calls).toEqual([]);
	});

	it("CUR-4388: offers the handoff beside the sandbox only when chat-agent-handoff is on, and tells the model when to use it", async () => {
		const { HANDOFF_CLAUSE } = await import("./handoffKit");
		const fx = fixtureSandbox();
		const opts = { withSandbox: true, sandboxFor: () => fx.server };
		const off = await mcpServersKitForTurn(ctx, async () => ({}), async () => [], { ...opts, handoffEnabled: () => false });
		expect(off?.definitions.map((d) => d.function.name)).not.toContain("hand_off_to_agent");
		expect(mcpToolsClause(off!)).not.toContain(HANDOFF_CLAUSE);
		const on = await mcpServersKitForTurn(ctx, async () => ({}), async () => [], { ...opts, handoffEnabled: () => true });
		expect(on?.definitions.map((d) => d.function.name)).toEqual(
			expect.arrayContaining(["sandbox__run_code", "hand_off_to_agent", "check_agent_task"])
		);
		expect(mcpToolsClause(on!)).toContain(HANDOFF_CLAUSE);
		// The sandbox's own calls still run through the MCP kit.
		await drain(on!.beforeRun([runCode]));
		expect((await on!.run(runCode)).mcpCall?.outcome).toBe("ok");
	});

	it("is not offered to a caller that did not ask for it (the router pre-pass)", async () => {
		const fx = fixtureSandbox();
		const kit = await mcpServersKitForTurn(ctx, async () => ({}), async () => [], { sandboxFor: () => fx.server });
		expect(kit).toBeUndefined();
	});
});

describe("what the trace shows of a call", () => {
	it("a server not named as shown keeps its arguments and result out of the trace", async () => {
		const { mcpServersKit } = await import("./serversKit");
		const { listServerTools } = await import("./serverTools");
		const fx = fixtureSandbox();
		const tools = await listServerTools([fx.server]);
		const kit = mcpServersKit({ tools, servers: [fx.server], policies: { sandbox__run_code: "allow" } });
		const res = await kit.run(runCode);
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.mcpCall).not.toHaveProperty("input");
		expect(res.mcpCall).not.toHaveProperty("output");
	});
});

describe("the sandbox turn's limits (CUR-4239)", () => {
	it("a kit with the sandbox runs 16 calls in order and asks for 6 rounds, kept when composed with the base kit", async () => {
		const { composeKits, MAX_MCP_CALLS_PER_TURN } = await import("./serversKit");
		const { CALCULATE_KIT } = await import("$lib/chat/server/endpoints/openai/calculateTool");
		const fx = fixtureSandbox();
		const kit = await mcpServersKitForTurn(ctx, async () => ({}), async () => [], {
			withSandbox: true,
			sandboxFor: () => fx.server,
		});
		const calls = Array.from({ length: 17 }, (_, i) => ({ ...runCode, id: `c${i}` }));
		await drain(kit!.beforeRun(calls));
		const outcomes = [];
		for (const c of calls) outcomes.push((await kit!.run(c)).mcpCall?.outcome);
		expect(MAX_MCP_CALLS_PER_TURN).toBe(4);
		expect(outcomes).toEqual([...Array(16).fill("ok"), "capped"]);
		expect(composeKits(CALCULATE_KIT, kit!).maxRounds).toBe(6);
		expect(composeKits(CALCULATE_KIT, kit!).sequential).toBe(true);
	});

	it("a kit without the sandbox keeps the default rounds and the 4-call cap", async () => {
		const { mcpServersKit, composeKits } = await import("./serversKit");
		const { listServerTools } = await import("./serverTools");
		const { CALCULATE_KIT } = await import("$lib/chat/server/endpoints/openai/calculateTool");
		const fx = fixtureSandbox();
		const kit = mcpServersKit({ tools: await listServerTools([fx.server]), servers: [fx.server], policies: { sandbox__run_code: "allow" } });
		const outcomes = [];
		for (let i = 0; i < 5; i++) outcomes.push((await kit.run({ ...runCode, id: `d${i}` })).mcpCall?.outcome);
		expect(outcomes).toEqual([...Array(4).fill("ok"), "capped"]);
		expect(composeKits(CALCULATE_KIT, kit).maxRounds).toBeUndefined();
		expect(composeKits(CALCULATE_KIT, kit).sequential).toBeUndefined();
	});
});
