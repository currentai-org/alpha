// operator-configured MCP servers, against two real MCP servers on 127.0.0.1 (the
// client.isError.spec.ts pattern). The real SDK client, the origin-scoped fetch, the kit and the tool
// loop all run unmocked; only the model is scripted. Each server records every request's headers, so
// "A's header reaches only A" is read off the wire, not off our own config. (CUR-3026)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
	ensureFlagsPolled: async () => {},
}));

const { parseMcpServers } = await import("./servers");
const { listServerTools, resetServerToolsCache } = await import("./serverTools");
const { mcpServersKit, MAX_MCP_CALLS_PER_TURN } = await import("./serversKit");
const { withToolLoop } = await import("$lib/chat/server/endpoints/openai/calculateTool");
const { answerMcpRequest } = await import("./e2eStub");
type McpFixture = import("./e2eStub").McpFixture;
const { fakeConfirm } = await import("./testFixtures");
type Output = import("$lib/chat/server/endpoints/types").TextGenerationStreamOutputSimplified;

type Seen = { path: string; headers: IncomingHttpHeaders; method?: string; tool?: string; args?: unknown };
type Fixture = { server: Server; url: string; origin: string; seen: Seen[] };

const TOOLS_A = [
	{
		name: "read_a",
		description: "Read a setting on A",
		inputSchema: { type: "object", properties: { name: { type: "string" } } },
		annotations: { readOnlyHint: true },
	},
	// No annotations at all: the spec's default, which must read as "may change something".
	{
		name: "write_a",
		description: "Change a setting on A",
		inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } },
	},
	{
		name: "broken_a",
		description: "Always fails",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
];
const TOOLS_B = [
	{
		name: "read_b",
		description: "Read a setting on B",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
];

function fixtureFor(tools: unknown[]): McpFixture {
	return {
		serverName: "two-servers-fixture",
		tools,
		call(name) {
			if (name === "broken_a") return { content: [{ type: "text", text: "the lock service is down" }], isError: true };
			if (name === "write_a") return { content: [{ type: "text", text: "accent changed to teal" }] };
			return { content: [{ type: "text", text: `${name}: accent = blue` }] };
		},
	};
}

/** A JSON-response MCP server. `redirectTo`, when set, answers /redirect with a 307 to that URL. */
async function startServer(tools: unknown[], redirectTo?: () => string): Promise<Fixture> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const entry: Seen = { path: req.url ?? "", headers: req.headers, method: req.method };
			seen.push(entry);
			if (req.url === "/redirect" && redirectTo) {
				res.writeHead(307, { location: redirectTo() }).end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			const msg = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
			if (msg.method === "tools/call") {
				entry.tool = msg.params?.name as string;
				entry.args = msg.params?.arguments;
			}
			const { status, payload } = answerMcpRequest(body, fixtureFor(tools));
			if (payload === undefined) {
				res.writeHead(status).end();
				return;
			}
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { server, url: `${origin}/mcp`, origin, seen };
}

let A: Fixture;
let B: Fixture;
const ENV: Record<string, string> = { A_KEY: "secret-for-a", B_KEY: "secret-for-b" };

beforeAll(async () => {
	B = await startServer(TOOLS_B);
	A = await startServer(TOOLS_A, () => B.url);
});
afterAll(async () => {
	await Promise.all([A, B].map((f) => new Promise<void>((r) => f.server.close(() => r()))));
});
afterEach(() => {
	A.seen.length = 0;
	B.seen.length = 0;
	resetServerToolsCache();
});

/** Plain http to 127.0.0.1 is what a test server is; the production guard (https, no loopback) is
 *  isValidUrl and ssrfSafeFetch, swapped here for the global fetch and an accept-all check. */
function configure(entries: unknown[]) {
	return parseMcpServers(JSON.stringify(entries), {
		env: (n) => ENV[n],
		validUrl: () => true,
		baseFetch: (url, init) => fetch(url, init),
	});
}

function twoServers() {
	return configure([
		{ name: "a", url: A.url, headers: { "X-Server-Key": "A_KEY" } },
		{ name: "b", url: B.url, headers: { "X-Server-Key": "B_KEY" } },
	]);
}

const call = (id: string, name: string, args: object = {}) => ({ id, name, arguments: JSON.stringify(args) });

const toolCalls = (seen: Seen[]) => seen.filter((s) => s.tool).map((s) => s.tool);

describe("two configured MCP servers (CUR-3026)", () => {
	it("offers every tool from both servers, each under its own server's name", async () => {
		const tools = await listServerTools(twoServers());
		expect(tools.map((t) => t.fnName).sort()).toEqual(["a__broken_a", "a__read_a", "a__write_a", "b__read_b"]);
		expect(tools.find((t) => t.fnName === "b__read_b")?.server).toBe("b");
		// Annotations are policy input, kept off what the model is sent.
		expect(JSON.stringify(tools.map((t) => t.definition))).not.toContain("readOnlyHint");
	});

	it("sends each server only its own header, on every request including the calls", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const kit = mcpServersKit({ tools, servers });
		await kit.run(call("1", "a__read_a", { name: "accent" }));
		await kit.run(call("2", "b__read_b"));
		expect(A.seen.length).toBeGreaterThan(0);
		expect(B.seen.length).toBeGreaterThan(0);
		expect(A.seen.every((s) => s.headers["x-server-key"] === "secret-for-a")).toBe(true);
		expect(B.seen.every((s) => s.headers["x-server-key"] === "secret-for-b")).toBe(true);
		expect(toolCalls(A.seen)).toEqual(["read_a"]);
		expect(toolCalls(B.seen)).toEqual(["read_b"]);
	});

	it("refuses to follow a redirect to another origin, so A's header never reaches B", async () => {
		const servers = configure([{ name: "a", url: `${A.origin}/redirect`, headers: { "X-Server-Key": "A_KEY" } }]);
		const tools = await listServerTools(servers);
		expect(A.seen.some((s) => s.path === "/redirect")).toBe(true);
		expect(B.seen.filter((s) => s.headers["x-server-key"] === "secret-for-a")).toEqual([]);
		expect(tools).toEqual([]);
	});

	it("drops a server whose header names an unset env var, and never sends a literal value", async () => {
		const servers = configure([
			{ name: "a", url: A.url, headers: { "X-Server-Key": "NOT_SET" } },
			{ name: "b", url: B.url, headers: { "X-Server-Key": "Bearer literal-secret" } },
		]);
		expect(servers).toEqual([]);
	});
});

describe("a tool not marked readOnlyHint runs only after the person confirms (CUR-3026)", () => {
	it("does not call the tool while the question is open, and calls it once allowed", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		let answer: string | undefined;
		const confirm = fakeConfirm(() => answer);
		let sleeps = 0;
		const kit = mcpServersKit({
			tools,
			servers,
			confirm,
			sleep: async () => {
				sleeps++;
				// The person answers while the turn is waiting; until now nothing may have run.
				if (sleeps === 3) {
					expect(toolCalls(A.seen)).toEqual([]);
					answer = "accept";
				}
			},
		});
		const c = call("w1", "a__write_a", { name: "accent", value: "teal" });
		const frames = [];
		for await (const f of kit.beforeRun([c])) frames.push(f);
		expect(confirm.opened).toEqual(["write_a"]);
		expect(frames[0].agentConfirm).toMatchObject({ kind: "mcp", channel: "mcp" });
		expect(frames[1].agentConfirmResult).toMatchObject({ decision: "allow" });
		const res = await kit.run(c);
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(toolCalls(A.seen)).toEqual(["write_a"]);
	});

	it("does not call the tool when the person declines, and says nothing changed", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const kit = mcpServersKit({ tools, servers, confirm: fakeConfirm(() => "decline") });
		const c = call("w2", "a__write_a", { name: "accent", value: "teal" });
		for await (const _ of kit.beforeRun([c])) void _;
		const res = await kit.run(c);
		expect(res.mcpCall?.outcome).toBe("declined");
		expect(res.content).toContain("nothing was changed");
		expect(toolCalls(A.seen)).toEqual([]);
	});

	it("treats a question nobody answers before the deadline as a no, and closes it", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		let t = 0;
		let expired = 0;
		const confirm = fakeConfirm(() => undefined);
		confirm.expire = async () => {
			expired++;
			return true;
		};
		const kit = mcpServersKit({
			tools,
			servers,
			confirm,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
			confirmWindowMs: 2_000,
		});
		const c = call("w3", "a__write_a", { name: "accent", value: "teal" });
		const frames = [];
		for await (const f of kit.beforeRun([c])) frames.push(f);
		expect(frames[1].agentConfirmResult).toMatchObject({ decision: "deny", reason: "timeout" });
		expect(expired).toBe(1);
		expect((await kit.run(c)).mcpCall?.outcome).toBe("timeout");
		expect(toolCalls(A.seen)).toEqual([]);
	});

	it("CUR-3983: with the default window, a yes that takes the person 30s to give still runs the tool", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		let t = 0;
		const confirm = fakeConfirm(() => (t >= 30_000 ? "accept" : undefined));
		const kit = mcpServersKit({
			tools,
			servers,
			confirm,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
		});
		const c = call("w4", "a__write_a", { name: "accent", value: "teal" });
		const frames = [];
		for await (const f of kit.beforeRun([c])) frames.push(f);
		expect(frames[1].agentConfirmResult).toMatchObject({ decision: "allow" });
		expect((await kit.run(c)).mcpCall?.outcome).toBe("ok");
		expect(toolCalls(A.seen)).toEqual(["write_a"]);
	});

	it("runs a readOnlyHint tool without asking", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const confirm = fakeConfirm(() => undefined);
		const kit = mcpServersKit({ tools, servers, confirm });
		const c = call("r1", "a__read_a", { name: "accent" });
		for await (const _ of kit.beforeRun([c])) void _;
		expect(confirm.opened).toEqual([]);
		expect((await kit.run(c)).mcpCall?.outcome).toBe("ok");
	});

	it("reports an isError result as a failure that did not happen, fenced as data", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const kit = mcpServersKit({ tools, servers });
		const res = await kit.run(call("e1", "a__broken_a"));
		expect(res.mcpCall?.outcome).toBe("tool_error");
		expect(res.content).toContain("did NOT happen");
		expect(res.content).toContain("not instructions");
		expect(res.content).toContain("the lock service is down");
	});
});

// The tool loop's model side, scripted: each request returns the next round's calls, or text.
function scriptedAttempt(rounds: Array<Array<ReturnType<typeof call>> | string>) {
	let i = 0;
	const tok = (text: string) => ({ token: { id: 0, text, logprob: 0, special: false }, generated_text: null, details: null });
	return async () => {
		const step = rounds[Math.min(i++, rounds.length - 1)];
		return (async function* (): AsyncGenerator<Output, void, void> {
			if (typeof step === "string") {
				yield tok(step) as Output;
				yield { ...tok(""), token: { id: 0, text: "", logprob: 0, special: true }, generated_text: step } as Output;
				return;
			}
			yield { ...tok(""), toolCalls: step } as Output;
		})();
	};
}

async function drain(gen: AsyncGenerator<Output, void, void>): Promise<Output[]> {
	const out: Output[] = [];
	for await (const o of gen) out.push(o);
	return out;
}

describe("the multi-call loop (CUR-3026)", () => {
	it("makes a read and then a confirmed write in one turn", async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const kit = mcpServersKit({ tools, servers, confirm: fakeConfirm(() => "accept") });
		const out = await drain(
			await withToolLoop({
				messages: [{ role: "user", content: "read my accent, then set it to teal" }],
				attempt: scriptedAttempt([
					[call("c1", "a__read_a", { name: "accent" })],
					[call("c2", "a__write_a", { name: "accent", value: "teal" })],
					"Done: accent was blue, now teal.",
				]),
				kit,
			})
		);
		expect(toolCalls(A.seen)).toEqual(["read_a", "write_a"]);
		expect(out.flatMap((o) => o.mcpCalls ?? []).map((c) => `${c.tool}:${c.outcome}`)).toEqual(["read_a:ok", "write_a:ok"]);
		expect(out.some((o) => o.agentConfirm?.title.includes("write_a"))).toBe(true);
		expect(out.at(-1)?.generated_text).toContain("now teal");
	});

	it(`stops calling servers at ${MAX_MCP_CALLS_PER_TURN} calls however many the model asks for`, async () => {
		const servers = twoServers();
		const tools = await listServerTools(servers);
		const kit = mcpServersKit({ tools, servers });
		const loopForever = Array.from({ length: 9 }, (_, i) => [call(`r${i}`, "a__read_a", { name: "accent" })]);
		const out = await drain(
			await withToolLoop({
				messages: [{ role: "user", content: "keep reading" }],
				attempt: scriptedAttempt([...loopForever, "stopped"]),
				kit,
				// Well past the kit's cap, so it is the kit that stops the calls and not the round limit.
				maxRounds: 8,
			})
		);
		expect(toolCalls(A.seen)).toHaveLength(MAX_MCP_CALLS_PER_TURN);
		const outcomes = out.flatMap((o) => o.mcpCalls ?? []).map((c) => c.outcome);
		expect(outcomes.filter((o) => o === "ok")).toHaveLength(MAX_MCP_CALLS_PER_TURN);
		expect(outcomes.slice(MAX_MCP_CALLS_PER_TURN).every((o) => o === "capped")).toBe(true);
	});
});
