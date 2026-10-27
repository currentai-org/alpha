import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectMcp } from "./client";
import { runMcpTool } from "./executor";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A real MCP server over Streamable HTTP, small enough to read: JSON-RPC in, one JSON response out.
// The real SDK client talks to it unmocked, so `isError` crosses the same wire it would from a Space
// or a Folkways server (CUR-2645). Two tools: one that refuses with `isError`, one that succeeds.
const TOOLS = [
	{ name: "refuse", description: "Always refuses", inputSchema: { type: "object", properties: {} } },
	{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: {} } },
];

function respond(method: string, params: Record<string, unknown> | undefined): unknown {
	if (method === "initialize") {
		return {
			protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "isError-fixture", version: "0.0.0" },
		};
	}
	if (method === "tools/list") return { tools: TOOLS };
	if (method === "tools/call") {
		return params?.name === "refuse"
			? { content: [{ type: "text", text: "a narrower layer may not widen this rule" }], isError: true }
			: { content: [{ type: "text", text: "done" }] };
	}
	return undefined;
}

let server: Server;
let url: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const msg = JSON.parse(body) as {
				id?: number | string;
				method: string;
				params?: Record<string, unknown>;
			};
			if (msg.id === undefined) {
				res.writeHead(202).end(); // a notification gets no response body
				return;
			}
			const result = respond(msg.method, msg.params);
			const payload =
				result === undefined
					? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }
					: { jsonrpc: "2.0", id: msg.id, result };
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("an MCP tool that answers isError is a failure, never a result to ground on (CUR-2645)", () => {
	it("returns tool_error with the tool's own reason when the server sets isError", async () => {
		const conn = await connectMcp(url, { timeoutMs: 5000 });
		try {
			await expect(runMcpTool(conn, "refuse", {})).resolves.toEqual({
				ok: "tool_error",
				message: "a narrower layer may not widen this rule",
			});
		} finally {
			await conn.close();
		}
	});

	it("still returns ok:true for a tool that succeeds on the same server", async () => {
		const conn = await connectMcp(url, { timeoutMs: 5000 });
		try {
			await expect(runMcpTool(conn, "echo", {})).resolves.toEqual({ ok: true, result: "done" });
		} finally {
			await conn.close();
		}
	});
});

describe("runMcpTool — an isError result with no text still reads as a failure", () => {
	it("substitutes a plain placeholder rather than an empty reason", async () => {
		const call = vi.fn().mockResolvedValue({ kind: "error", text: "" });
		await expect(runMcpTool({ call }, "refuse", {})).resolves.toEqual({
			ok: "tool_error",
			message: "The tool reported an error with no message.",
		});
	});
});
