// What each model request actually carried, one `[request] sent` line per HTTP request. With it, two
// turns of the same question whose prompt token counts differ can be compared field by field.
//
// Every environment gets a line with no content in it: parameters, tool names, header names, each
// message's role and length, and the system prompt's hash and paragraph lengths. Deployments other than
// production also get each system paragraph's hash, so two turns can be diffed section by section. An
// undeclared environment counts as production. No deployment logs the body or any message text: stdout
// reaches long-lived log storage through the log drain, which account deletion never touches.
import { createHash } from "node:crypto";

/** Sampling and cap fields logged as values; every other body key is logged by name only. */
const PARAM_KEYS = [
	"model",
	"stream",
	"max_tokens",
	"max_completion_tokens",
	"temperature",
	"top_p",
	"frequency_penalty",
	"presence_penalty",
	"reasoning_effort",
	"disable_fallbacks",
	"parallel_tool_calls",
] as const;

/** Headers whose values say how the request was handled and identify no one. Credentials, the
 *  conversation id and a local endpoint's own headers are logged by name only. */
const HEADER_VALUES = new Set([
	"chatui-serves-user-answer",
	"chatui-fault-substitute-model",
	"chatui-fault-model-replay",
	"x-use-cache",
	"user-agent",
]);

const hash = (text: string, n = 12) => createHash("sha256").update(text).digest("hex").slice(0, n);

type Message = { role?: unknown; content?: unknown; tool_calls?: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
			.join("");
	return "";
}

function sizeOf(content: unknown): number {
	if (content === undefined || content === null) return 0;
	return typeof content === "string" ? content.length : JSON.stringify(content).length;
}

/**
 * The fields of a `[request] sent` line for one request body and its headers.
 *
 * @remarks
 * Pure, so the production and non-production shapes are tested without a logger. `full` is
 * `isTestDeployment()`: false on production and on an undeclared environment.
 */
export function describeRequest(
	body: Record<string, unknown>,
	headers: Record<string, string | undefined>,
	full: boolean
): Record<string, unknown> {
	const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => textOf(m.content))
		.join("\n\n");
	const paragraphs = system.split(/\n{2,}/).filter((p) => p.trim().length > 0);
	const tools = Array.isArray(body.tools)
		? body.tools.map((t) => (t as { function?: { name?: string } })?.function?.name ?? "?")
		: [];
	const toolChoice = body.tool_choice;

	const fields: Record<string, unknown> = {
		params: Object.fromEntries(PARAM_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])),
		bodyKeys: Object.keys(body).sort(),
		tools,
		toolChoice:
			typeof toolChoice === "string"
				? toolChoice
				: (toolChoice as { function?: { name?: string } } | undefined)?.function?.name,
		// "system:18762", "user:61": role and length, in order, never the text.
		turns: messages.map(
			(m) => `${String(m.role)}:${sizeOf(m.content)}${m.tool_calls ? `+calls:${sizeOf(m.tool_calls)}` : ""}`
		),
		// The completions path sends one flattened prompt instead of messages.
		...(typeof body.prompt === "string" ? { promptChars: body.prompt.length } : {}),
		systemHash: hash(system),
		systemChars: system.length,
		systemParagraphChars: paragraphs.map((p) => p.length),
		// An array, not an object: a local endpoint names its own headers, and an object would give Axiom a
		// column per name.
		headers: Object.entries(headers)
			.filter(([, v]) => v !== undefined && v !== "")
			.map(([k, v]) => `${k}=${HEADER_VALUES.has(k.toLowerCase()) ? v : "<set>"}`),
	};
	if (!full) return fields;

	// The paragraph that differs between two turns is the one whose hash differs.
	fields.systemParagraphHashes = paragraphs.map((p) => hash(p, 8));
	return fields;
}
