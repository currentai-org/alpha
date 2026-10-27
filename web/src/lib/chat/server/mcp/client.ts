// MCP client — connect to an MCP server (e.g. an HF Gradio Space's /gradio_api/mcp/sse),
// list its tools as OpenAI-shaped function schemas, and call them. Thin wrapper over the
// official @modelcontextprotocol/client (SDK v2, CUR-1017 — the split successor to the single
// @modelcontextprotocol/sdk package). The tool DECISION is made elsewhere by a bare-prompt
// router (the persona suppresses in-context tool-choice by design — see
// docs/mcp-restoration-scope.md); this module is just the transport + invocation.
import {
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	isInputRequiredResult,
	type InputRequests,
} from "@modelcontextprotocol/client";
import { logger } from "$lib/chat/server/logger";
import { mcpToolToOpenAITool, stripPlaceholderArgs, type McpTool } from "./schema";
import { elicitationEnabled } from "./elicitationConfig";
import type OpenAI from "openai";

// A 2026-era server can answer a call with `input_required` instead of a result — it needs more
// input before it can finish, and its own request ends immediately (CUR-1017). Nothing is waiting
// anywhere once this comes back, so the caller decides what to do with it (index.ts parks it).
// A tool that fails reports it as a normal result with `isError: true` and the reason in its text
// blocks (MCP spec, "Error Handling"), so a call that resolved is not a call that worked (CUR-2645).
export type McpCallResult =
	| { kind: "text"; text: string }
	| { kind: "error"; text: string }
	| { kind: "input_required"; inputRequests: InputRequests; requestState?: string };

export type McpConnection = {
	/** Raw MCP tool defs from the server. */
	tools: McpTool[];
	/** Same tools as OpenAI function schemas (no-param tools placeholder-padded). */
	openaiTools: OpenAI.Chat.ChatCompletionFunctionTool[];
	/** Invoke a tool by name; placeholder pad is stripped, text content blocks are flattened. */
	call(name: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<McpCallResult>;
	close(): Promise<void>;
};

/** `onProgress` hears each progress message the server sends while the call runs. (CUR-4584) */
/** `signal` ends the request when the turn is aborted or its budget runs out. (CUR-4627) */
export type McpCallOptions = { onProgress?: (message: string) => void; timeoutMs?: number; signal?: AbortSignal };

/** Connect, handshake, and list tools. Caller owns close(). Throws on connect/list failure.
 *  Transport: Streamable HTTP by default (the current standard — validated against a real MCP
 *  server in evals/mcp-live-probe); legacy SSE only for an explicit `/sse` URL. `headers` lets
 *  an authed server be reached (open Gradio Spaces need none). */
export async function connectMcp(
	url: string,
	opts?: {
		headers?: Record<string, string>;
		timeoutMs?: number;
		/** The fetch every request goes through. An operator-configured server passes an (CUR-3026)
		 *  origin-scoped fetch, so its headers never follow a redirect to another origin. */
		fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
	}
): Promise<McpConnection> {
	// Spelled out, not a bare `{ elicitation: {} }` — the server SDK reads a bare object as
	// form-only and refuses to ever send a URL elicitation. Declared only alongside the handler
	// below that implements it (elicitationEnabled() gates both together), never before it — an
	// advertised capability nothing answers gets the server a method-not-found instead of a
	// clean decline.
	const capabilities = elicitationEnabled() ? { elicitation: { form: {}, url: {} } } : {};
	const client = new Client(
		{ name: "aipotluck.org", version: "0.1.0" },
		{
			capabilities,
			// SDK v2 (CUR-1017) defaults to 'legacy' — never negotiating, always the 2025 handshake.
			// Probe instead: try the current protocol first, fall back to legacy on a server that
			// doesn't answer it.
			versionNegotiation: { mode: "auto" },
			// A 2026-era `input_required` result should come back as data (handled per-call via
			// `allowInputRequired`, below), never auto-answered by the SDK on our behalf.
			inputRequired: { autoFulfill: false },
		}
	);

	// This repo doesn't support the 2025-era BLOCKING elicitation flow at all — see
	// schema.ts's mcpElicitations comment for why (a Vercel invocation cannot survive an
	// hour-long wait for a human, regardless of implementation). A legacy server that still
	// pushes a genuine `elicitation/create` request gets an immediate, honest decline instead
	// of a held-open call that would eventually be killed by the platform with nothing
	// persisted. Registered only when the capability is advertised — an unregistered handler
	// for an undeclared capability would never be invoked anyway.
	if (capabilities.elicitation) {
		client.setRequestHandler("elicitation/create", async () => ({ action: "decline" as const }));
	}
	const init =
		opts?.headers || opts?.fetch
			? {
					...(opts.headers ? { requestInit: { headers: opts.headers } } : {}),
					...(opts.fetch ? { fetch: opts.fetch } : {}),
				}
			: undefined;
	const transport = url.endsWith("/sse")
		? new SSEClientTransport(new URL(url), init)
		: new StreamableHTTPClientTransport(new URL(url), init);

	// Bound connect + handshake. An HF Space asleep cold-starts in 30–60s and the SDK's
	// connect()/listTools() have NO timeout — on a plain turn that whole wake blocks the answer
	// before the first token. Race a deadline; on
	// timeout the caller (maybeRunMcpTool) fails open to no-tool. Per-step timing is logged so we
	// can see whether the Space WAKE (connect) or the tool listing is what's slow. timeoutMs is ONE
	// budget for the WHOLE handshake — each step races the time REMAINING, not a fresh window (two
	// fresh windows would let a 55s "budget" run ~110s). Timers are cleared on settle so a
	// finished handshake doesn't leave a long-fuse timer holding the function open.
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	const startedAt = Date.now();
	const deadline = <T>(p: Promise<T>, label: string): Promise<T> => {
		const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			p,
			new Promise<T>((_, rej) => {
				timer = setTimeout(
					() =>
						rej(
							new Error(`[mcp] ${label} timed out after ${remaining}ms (budget ${timeoutMs}ms)`)
						),
					remaining
				);
			}),
		]).finally(() => clearTimeout(timer));
	};

	const tConnect = Date.now();
	await deadline(client.connect(transport), "connect");
	const connectMs = Date.now() - tConnect;
	const tList = Date.now();
	const listed = await deadline(client.listTools(), "listTools");
	const listToolsMs = Date.now() - tList;
	logger.info({ connectMs, listToolsMs, timeoutMs }, "[mcp] connect timing");

	const tools = (listed.tools ?? []) as McpTool[];

	return {
		tools,
		openaiTools: tools.map(mcpToolToOpenAITool),
		async call(name, args, callOpts) {
			const onProgress = callOpts?.onProgress;
			// Ask for input_required as DATA rather than letting the driver block on it — a
			// 2026-era prompt is answered out of band, not inside this call (CUR-1017).
			const res = await client.callTool(
				{ name, arguments: stripPlaceholderArgs(args) },
				{
					allowInputRequired: true,
					...(onProgress
						? { onprogress: (p: { message?: string }) => p.message && onProgress(p.message) }
						: {}),
					...(callOpts?.timeoutMs ? { timeout: callOpts.timeoutMs } : {}),
					...(callOpts?.signal ? { signal: callOpts.signal } : {}),
				}
			);
			if (isInputRequiredResult(res)) {
				return {
					kind: "input_required",
					inputRequests: res.inputRequests ?? {},
					...(res.requestState !== undefined ? { requestState: res.requestState } : {}),
				};
			}
			const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
			const text = blocks
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();
			return res.isError === true ? { kind: "error", text } : { kind: "text", text };
		},
		async close() {
			try {
				await client.close();
			} catch (e) {
				logger.warn(e, "[mcp] close failed");
			}
		},
	};
}
