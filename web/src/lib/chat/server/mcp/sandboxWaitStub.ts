// A stand-in for agent-service's /mcp/ on a full host. It answers a run the way the real server does
// when connect has to wait for a slot: the call's reply is an SSE stream carrying one MCP progress
// notification, "Waiting for a free sandbox…", then the result after `holdMs`. The progress, the SDK client,
// the kit's frames and the live line all run unmodified; only the sandbox is stood in. (CUR-4584)
import { answerMcpRequest, type McpFixture } from "./e2eStub";
import { originScopedFetch, type McpServerConfig } from "./servers";

const SANDBOX_WAIT_TEXT = "Waiting for a free sandbox…";
/** What the stand-in's run_code prints once its wait is over.
 *  @internal exported for serversKit.sandboxWait.spec */
export const SANDBOX_WAIT_STUB_STDOUT = "8796093022208";
const SANDBOX_WAIT_STUB_URL = "https://sandbox-wait-stub.e2e.invalid/mcp/";

const RUN_CODE = {
	name: "run_code",
	description:
		"Run Python 3 code in this conversation's workspace and return what it printed. Print the values you need; the last expression is not echoed. No internet.",
	inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

const FIXTURE: McpFixture = {
	serverName: "sandbox",
	tools: [RUN_CODE],
	call: (tool) =>
		tool === "run_code"
			? { content: [{ type: "text", text: `exit code 0 (4 ms)\nstdout:\n${SANDBOX_WAIT_STUB_STDOUT}\n` }] }
			: { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true },
};

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

/** A fetch answering as the sandbox does on a full host: every tools/call waits `holdMs`, saying so first.
 *  @internal exported for serversKit.sandboxWait.spec */
export function sandboxWaitFetch(holdMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
	return async (_url: string | URL, init?: RequestInit): Promise<Response> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 405 });
		const body = String(init?.body ?? "{}");
		const msg = JSON.parse(body) as { method?: string; params?: { _meta?: { progressToken?: string | number } } };
		const { status, payload } = answerMcpRequest(body, FIXTURE);
		if (payload === undefined) return new Response(null, { status });
		if (msg.method !== "tools/call") {
			return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
		}
		const token = msg.params?._meta?.progressToken;
		const enc = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				if (token !== undefined) {
					controller.enqueue(
						enc.encode(
							sse({
								jsonrpc: "2.0",
								method: "notifications/progress",
								params: { progressToken: token, progress: 0, message: SANDBOX_WAIT_TEXT },
							})
						)
					);
				}
				await sleep(holdMs);
				controller.enqueue(enc.encode(sse(payload)));
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

/** The stand-in in place of the sandbox server the turn was offered: the same config, so its name, call
 *  timeout and wait handling follow the real one, with only the address and the fetch swapped. */
export function sandboxWaitStubServer(offered: McpServerConfig, holdMs: number): McpServerConfig {
	const origin = new URL(SANDBOX_WAIT_STUB_URL).origin;
	return {
		...offered,
		url: SANDBOX_WAIT_STUB_URL,
		headers: {},
		origin,
		fetch: originScopedFetch(origin, sandboxWaitFetch(holdMs)),
	};
}
