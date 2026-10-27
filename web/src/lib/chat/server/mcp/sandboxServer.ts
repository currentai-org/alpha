// The conversation's sandbox as an MCP server on a native chat turn (CUR-4232). agent-service serves the
// box the agent runs in at `/mcp/` (agent-service/api/sandbox_mcp.py): Python and a shell, the
// conversation's own workdir, no network and an environment built from nothing. Chat already has web
// search, so with these tools beside it one turn can look something up and then compute on it.
//
// The server is defined here in code. MCP_SERVERS cannot carry it, because two of its headers are per request: the
// visitor's subject (the same derivation the agent turn uses, so both land in one workdir) and the
// conversation id, which keys that workdir.
//
// Its tools run without a confirmation card unless the person chose ask or never for one in Settings →
// Connectors. What the card guards against is a tool reaching out or leaking; this box can do neither,
// and Claude Code, Cursor and Claude.ai all run sandboxed code without asking per call (research on
// CUR-4232). A tool here that ever gains network goes back behind the card.
import { flagEnabledOr } from "$lib/chat/server/flags";
import { agentServiceToken, agentServiceUrl } from "$lib/chat/server/agentMode";
import { agentServiceHeaders } from "$lib/chat/server/endpoints/agent/endpointAgent";
import type { McpToolPolicy } from "$lib/chat/mcpToolPolicy";
import { originScopedFetch, type McpServerConfig } from "./servers";
import type { ServerTool } from "./serverTools";

/** PostHog flag key. Owner: chat. Gates whether a native turn gets the sandbox's tools.
 *  @internal exported for flagKeys.spec */
export const ONE_CHAT_SANDBOX_FLAG = "one-chat-sandbox";
export const SANDBOX_SERVER_NAME = "sandbox";

/** A turn with the sandbox may run 6 tool rounds, where every other turn gets 3 rounds and 4 calls. (CUR-4239)
 *  A write, run and check task needs four rounds or more (CUR-4232). */
export const SANDBOX_MAX_ROUNDS = 6;
/** 16 calls: Large 3 through chat makes one call per file, so a multi-step task needs about 12
 *  calls. Six rounds stay the bound. */
export const SANDBOX_MAX_CALLS = 16;
/** One sandbox call. agent-service waits up to 60 s (E2B_BUSY_WAIT_SECS) for a slot on a full host, (CUR-4584)
 *  and the code then gets its 7 s, so the SDK's 60 s default would cut off a call that was about to run. */
const SANDBOX_CALL_TIMEOUT_MS = 90_000;

function oneChatSandboxEnabled(): boolean {
	return flagEnabledOr(ONE_CHAT_SANDBOX_FLAG, () => false);
}

/** The sandbox server for this conversation, or undefined for a guest, when the flag is off, the
 *  deployment has no agent service, or its address is not https. A guest never gets it, whatever the
 *  flag's release conditions say: running code is for signed-in accounts, as agent mode is (CUR-4400). */
export function sandboxServerFor(
	conversationId: string,
	locals: App.Locals | undefined,
	deps: { enabled?: () => boolean; url?: () => string; token?: () => string } = {}
): McpServerConfig | undefined {
	if (!locals?.user?._id) return undefined;
	if (!(deps.enabled ?? oneChatSandboxEnabled)()) return undefined;
	const base = (deps.url ?? agentServiceUrl)();
	if (!base || !conversationId) return undefined;
	let url: URL;
	try {
		url = new URL("/mcp/", base);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	return {
		name: SANDBOX_SERVER_NAME,
		url: url.href,
		headers: { ...agentServiceHeaders((deps.token ?? agentServiceToken)(), locals), "x-agent-session": conversationId },
		origin: url.origin,
		fetch: originScopedFetch(url.origin),
		progressIsSandboxWait: true,
		callTimeoutMs: SANDBOX_CALL_TIMEOUT_MS,
	};
}

/** The person's choices, with "allow" filled in for every sandbox tool they have not set. */
export function withSandboxDefaults(
	policies: Readonly<Record<string, McpToolPolicy>>,
	tools: ServerTool[]
): Record<string, McpToolPolicy> {
	const out: Record<string, McpToolPolicy> = { ...policies };
	for (const t of tools) {
		if (t.server === SANDBOX_SERVER_NAME && out[t.fnName] === undefined) out[t.fnName] = "allow";
	}
	return out;
}

/** What the model is told when the sandbox's tools are offered. */
export const SANDBOX_CLAUSE =
	"The sandbox__ tools run Python 3 (with numpy, pandas and matplotlib) and a shell in a private workspace for this conversation. The workspace has no internet. When a question needs facts and then a calculation, such as counting days to an event, look the facts up with web search first, then compute with sandbox__run_code using the values you found, and give the result. Print every value you need; only printed output comes back.";
