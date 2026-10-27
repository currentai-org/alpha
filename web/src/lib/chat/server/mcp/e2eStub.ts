// A stub MCP server answered inside this deployment, for the `mcp_stub_server` fault (CUR-3026). It is
// reached through a fetch that never leaves the process: a preview's own URL sits behind Vercel's
// deployment protection, which a server-side request cannot pass, and a third party's server would make
// the spec test someone else's uptime. The JSON-RPC it speaks is the real Streamable HTTP shape, so the
// real SDK client, the origin-scoped fetch and the tool loop all run unmodified.
//
// Three tools, one per rule the feature has to keep:
//   get_setting      readOnlyHint: true, so it runs without asking.
//   set_setting      no annotations, so it runs only after the person allows it.
//   get_admin_lock   readOnlyHint: true, and always answers isError (CUR-2645): the answer must say
//                    it failed, never ground on the error text as a result.
import { originScopedFetch, type McpServerConfig } from "./servers";

const STUB_SERVER_NAME = "stub";
export const STUB_URL = "https://mcp-stub.e2e.invalid/mcp";
/** The value the read tool returns, which the spec looks for in the answer. */
const STUB_SETTING_VALUE = "teal";

const TOOLS = [
	{
		name: "get_setting",
		description: "Read the current value of one of the person's settings, by name (for example: accent_color).",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string", description: "The setting's name" } },
			required: ["name"],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: "set_setting",
		description: "Change one of the person's settings to a new value.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "The setting's name" },
				value: { type: "string", description: "The new value" },
			},
			required: ["name", "value"],
		},
	},
	{
		name: "get_admin_lock",
		description: "Read whether an administrator has locked the person's settings.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
];

type ToolCallResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** What a JSON-response MCP server needs to answer: its name, its tool list, and how a call runs. */
export type McpFixture = {
	serverName: string;
	tools: unknown[];
	call: (name: string, args: Record<string, unknown>) => ToolCallResult;
};

/**
 * One Streamable HTTP POST body answered the way a JSON-response MCP server does: a notification gets
 * 202, a request gets its JSON-RPC result or a method-not-found error. Shared by this stub and the
 * two-server vitest fixture, so both speak the protocol the same way.
 */
export function answerMcpRequest(body: string, fixture: McpFixture): { status: number; payload?: unknown } {
	const msg = JSON.parse(body || "{}") as { id?: number | string; method: string; params?: Record<string, unknown> };
	if (msg.id === undefined) return { status: 202 };
	let result: unknown;
	if (msg.method === "initialize") {
		result = {
			protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: fixture.serverName, version: "0.0.0" },
		};
	} else if (msg.method === "tools/list") {
		result = { tools: fixture.tools };
	} else if (msg.method === "tools/call") {
		result = fixture.call(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
	}
	return {
		status: 200,
		payload:
			result === undefined
				? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }
				: { jsonrpc: "2.0", id: msg.id, result },
	};
}

function callStubTool(tool: string, args: Record<string, unknown>): ToolCallResult {
	const name = typeof args.name === "string" ? args.name : "accent_color";
	if (tool === "get_setting") return { content: [{ type: "text", text: `${name} = ${STUB_SETTING_VALUE}` }] };
	if (tool === "set_setting") {
		const value = typeof args.value === "string" ? args.value : "";
		return { content: [{ type: "text", text: `${name} changed from ${STUB_SETTING_VALUE} to ${value}` }] };
	}
	if (tool === "get_admin_lock") {
		return { content: [{ type: "text", text: "lock service unavailable (stub error 503)" }], isError: true };
	}
	return { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true };
}

const STUB_FIXTURE: McpFixture = { serverName: "aipotluck-e2e-stub", tools: TOOLS, call: callStubTool };

/** A fetch that answers each Streamable HTTP request from `fixture`, the way a JSON-response MCP
 *  server does. */
function fixtureFetch(fixture: McpFixture) {
	return async (_url: string | URL, init?: RequestInit): Promise<Response> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 405 });
		const { status, payload } = answerMcpRequest(String(init?.body ?? "{}"), fixture);
		if (payload === undefined) return new Response(null, { status });
		return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
	};
}

/** A stand-in as a configured server, behind the same origin-scoped fetch a real one gets. */
function fixtureServer(name: string, url: string, fetchFn: ReturnType<typeof fixtureFetch>): McpServerConfig {
	const origin = new URL(url).origin;
	return { name, url, headers: {}, origin, fetch: originScopedFetch(origin, fetchFn) };
}

/** Answers one Streamable HTTP request the way a JSON-response MCP server does. */
export const stubMcpFetch = fixtureFetch(STUB_FIXTURE);

/** The stub as a configured server, behind the same origin-scoped fetch a real one gets. */
export function stubMcpServer(): McpServerConfig {
	return fixtureServer(STUB_SERVER_NAME, STUB_URL, stubMcpFetch);
}

// A stand-in for the conversation's sandbox, for the `sandbox_stub` fault. It carries the real
// sandbox's server name, so the usage tier in sandboxAllowance.ts stands in front of it exactly as it
// does in front of agent-service's /mcp/. A spec can then drive a run and the limit message on a preview
// without a live E2B host. It answers every run with the same printed line. (CUR-4578)
const SANDBOX_STUB_URL = "https://sandbox-stub.e2e.invalid/mcp/";
/** What the stub's run_code prints, which the spec looks for in the trace. */
const SANDBOX_STUB_STDOUT = "1267650600228229401496703205376";

const SANDBOX_STUB_FIXTURE: McpFixture = {
	serverName: "sandbox",
	tools: [
		{
			name: "run_code",
			description:
				"Run Python 3 code in this conversation's workspace and return what it printed. Print the values you need; the last expression is not echoed. No internet.",
			inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
		},
	],
	call: (tool) =>
		tool === "run_code"
			? { content: [{ type: "text", text: `exit code 0 (3 ms)\nstdout:\n${SANDBOX_STUB_STDOUT}\n` }] }
			: { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true },
};

const sandboxStubFetch = fixtureFetch(SANDBOX_STUB_FIXTURE);

/** The sandbox stand-in, named as the real sandbox server is (`SANDBOX_SERVER_NAME`). */
export function stubSandboxServer(name: string): McpServerConfig {
	return fixtureServer(name, SANDBOX_STUB_URL, sandboxStubFetch);
}
