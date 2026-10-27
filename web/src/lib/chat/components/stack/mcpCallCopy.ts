import { m } from '$lib/paraglide/messages.js';

// A call to an MCP server, by how it ended. Functions, so the copy follows a language switch.
// Step by step and the "This answer" receipt (CUR-4038) both read these, so the two can't disagree. (CUR-3026)
export const MCP_CALL_TITLE: Record<string, () => string> = {
	ok: () => m.message_mcpTitleOk(),
	tool_error: () => m.message_mcpTitleToolError(),
	failed: () => m.message_mcpTitleFailed(),
	declined: () => m.message_mcpTitleDeclined(),
	timeout: () => m.message_mcpTitleTimeout(),
	capped: () => m.message_mcpTitleCapped(),
	allowance: () => m.message_mcpTitleAllowance(),
	blocked: () => m.message_mcpTitleBlocked(),
	call_timeout: () => m.message_mcpTitleCallTimeout()
};

const MCP_CALL_COPY: Record<string, (p: { tool: string; server: string }) => string> = {
	ok: (p) => m.message_mcpWhatOk(p),
	tool_error: (p) => m.message_mcpWhatToolError(p),
	failed: (p) => m.message_mcpWhatFailed(p),
	input_required: (p) => m.message_mcpWhatInputRequired(p),
	declined: (p) => m.message_mcpWhatDeclined(p),
	timeout: (p) => m.message_mcpWhatTimeout(p),
	capped: (p) => m.message_mcpWhatCapped(p),
	allowance: (p) => m.message_mcpWhatAllowance(p),
	blocked: (p) => m.message_mcpWhatBlocked(p),
	unknown_tool: (p) => m.message_mcpWhatUnknownTool(p),
	call_timeout: (p) => m.message_mcpWhatCallTimeout(p)
};

/** One sentence naming the tool, its server and what came of the call. */
export function mcpCallWhat(call: { tool: string; server: string; outcome: string }): string {
	const p = { tool: call.tool, server: call.server };
	return (MCP_CALL_COPY[call.outcome] ?? ((q) => m.message_mcpWhatDefault(q)))(p);
}
