// MCP tool definitions <-> OpenAI function-tool schemas.
//
// Bakes in the VERIFIED workaround for the serving-layer "tools without parameters" edge case
// (evals/tool-serving-probe): a tool whose input schema has no/empty properties makes the
// served model emit a malformed call (leaks <|tools_prefix|>). Padding the schema with one
// placeholder param fixes it — the model emits a clean parseable call; we strip the placeholder before
// the args reach the MCP server. So a no-arg Space tool is callable on our serving as-is.
import type OpenAI from "openai";

// Minimal shape of a tool from the SDK's client.listTools().
export type McpTool = {
	name: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
	/** MCP tool annotations (spec 2025-03-26+). Hints from the server, never a guarantee: only
	 *  `readOnlyHint: true` lets a tool run without the person confirming (CUR-3026). */
	annotations?: McpToolAnnotations;
};

export type McpToolAnnotations = {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** Copies only the boolean hints from a server's `annotations`, so a malformed or hostile value
 *  (a string "true", an object) reads as absent, and absent means "not read-only". Same rule as
 *  upstream chat-ui's readAnnotations (0f9f26b1). */
export function readAnnotations(raw: unknown): McpToolAnnotations | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: McpToolAnnotations = {};
	for (const hint of ANNOTATION_HINTS) {
		const value = (raw as Record<string, unknown>)[hint];
		if (typeof value === "boolean") out[hint] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// Distinctive name (unlikely to collide with a real Space param) for the placeholder pad.
export const PLACEHOLDER_PARAM = "_noop";

/** True when the tool advertises no input parameters — the no-param edge-case trigger. */
export function isNoParamTool(tool: McpTool): boolean {
	const props = tool.inputSchema?.properties;
	return !props || Object.keys(props).length === 0;
}

/** Workaround for tool-use chat templates (CSCS's among them) that
 *  access `.description` on every parameter property, so a property without that key 400s the
 *  whole request ("'dict object' has no attribute 'description'") and tool-calling fails open to
 *  no tool. Gradio Spaces routinely omit param descriptions (e.g. Chatterbox `text_input`), so we
 *  inject the key (defaulting to the param name) before sending. Shallow by design — Gradio tool
 *  params are flat; recurse here if a nested-object param ever needs it. */
export function ensureParamDescriptions(props: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(props)) {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const v = val as Record<string, unknown>;
			out[key] =
				typeof v.description === "string" && v.description.trim() ? v : { ...v, description: key };
		} else {
			out[key] = val;
		}
	}
	return out;
}

/** MCP tool -> OpenAI function tool. No-param tools get one placeholder optional arg so the served
 *  model emits a parseable tool_call (see file header).
 *
 *  Returns `ChatCompletionFunctionTool`, NOT `ChatCompletionTool`. the openai SDK defines the latter as a
 *  union — a function tool or a "custom" (freeform-grammar) tool — and every tool this codebase builds
 *  is a function tool. Naming the narrow variant here is what lets the rest of the MCP layer keep
 *  reading `.function` unconditionally instead of narrowing at each of eight call sites. If we ever emit a custom tool, that is
 *  a deliberate change starting at this return type, and the compiler will point at everywhere it
 *  matters. */
export function mcpToolToOpenAITool(tool: McpTool): OpenAI.Chat.ChatCompletionFunctionTool {
	const parameters = isNoParamTool(tool)
		? {
				type: "object",
				properties: {
					[PLACEHOLDER_PARAM]: { type: "string", description: "ignored; leave empty" },
				},
			}
		: {
				type: "object",
				properties: ensureParamDescriptions(tool.inputSchema?.properties ?? {}),
				...(tool.inputSchema?.required?.length ? { required: tool.inputSchema.required } : {}),
			};
	return {
		type: "function",
		function: {
			name: tool.name,
			// CSCS's template also reads the tool-level description; never send empty.
			description: tool.description?.trim() || tool.name,
			parameters,
		},
	};
}

/** Drop the placeholder pad (if present) from the model's tool-call args before invoking the real
 *  MCP tool — the Space never sees it. */
export function stripPlaceholderArgs(args: Record<string, unknown>): Record<string, unknown> {
	if (!(PLACEHOLDER_PARAM in args)) return args;
	const rest = { ...args };
	delete rest[PLACEHOLDER_PARAM];
	return rest;
}

/** Parse the JSON arguments string from a model tool_call into an object (safe: {} on junk). */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
