// Reads a forced tool call's arguments back out of a model response, from either the structured
// `tool_calls` entry or the inline marker some backends leave in the message content. Used by math
// routing (mathRouting.ts).

// ── CUR-1143 fallback: a backend may return Apertus's native tool-call token in the message content
// instead of a structured tool_calls entry — `<|tools_prefix|>[{"toolName": {...args}}]` sitting in
// the content as prose, with the right tool and arguments chosen. A forced and an auto tool_choice
// call against swiss-ai/apertus-v1.5-70b both produce this shape. This extracts the same information
// from content when tool_calls came back empty — every downstream
// parser (parsePriorTotal, parseBaseTime, ...) sees the identical JSON-string-of-arguments shape either
// way and needs no change.

const TOOLS_PREFIX_MARKER = "<|tools_prefix|>";
const TOOLS_SUFFIX_MARKER = "<|tools_suffix|>";

// Bounding follows vLLM's Apertus parser (Apache-2.0), vllm-project/vllm@24c9772d
// `vllm/tool_parsers/apertus_tool_parser.py`: the block runs from the prefix to `<|tools_suffix|>`
// or the end of the text, and the arguments are the first complete JSON value in it (Python's
// `raw_decode`). JS has no `raw_decode`, so the scan below tracks strings and escapes to find where
// that value ends; a `]` inside a string argument is text, not structure. vLLM's partial-JSON
// fallback for truncated output is not ported: a truncated call stays undefined. (CUR-2151)

/** The first complete JSON array at the start of `text` (after leading whitespace), or undefined if it
 *  never closes. Brackets inside string values and escaped quotes are skipped. */
function leadingJsonArray(text: string): string | undefined {
	const start = text.search(/\S/);
	if (start === -1 || text[start] !== "[") return undefined;
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/** Pulls `toolName`'s arguments out of Apertus's inline `<|tools_prefix|>` marker, as the same
 *  JSON-string-of-arguments shape a real `tool_calls[].function.arguments` field carries. Returns
 *  undefined on anything that doesn't parse as `[{ [toolName]: {...} }, ...]` — never guessed at. */
export function extractInlineToolCallArgs(content: string | null | undefined, toolName: string): string | undefined {
	if (!content) return undefined;
	const idx = content.indexOf(TOOLS_PREFIX_MARKER);
	if (idx === -1) return undefined;
	const block = content.slice(idx + TOOLS_PREFIX_MARKER.length);
	const suffixAt = block.indexOf(TOOLS_SUFFIX_MARKER);
	const arrayText = leadingJsonArray(suffixAt === -1 ? block : block.slice(0, suffixAt));
	if (!arrayText) return undefined;
	try {
		const parsed = JSON.parse(arrayText) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		for (const entry of parsed) {
			if (entry && typeof entry === "object" && toolName in (entry as Record<string, unknown>)) {
				return JSON.stringify((entry as Record<string, unknown>)[toolName]);
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export type ToolCallMessage = {
	content?: string | null;
	tool_calls?: Array<{ type?: string; function?: { name?: string; arguments?: string } }>;
};

/** Finds `toolName`'s raw arguments JSON string from a completion message: the STRUCTURED tool_calls
 *  entry first (the correct, spec-shaped path), falling back to the inline `<|tools_prefix|>` extraction
 *  above only when tool_calls came back empty. */
export function rawToolCallArgs(message: ToolCallMessage | undefined, toolName: string): string | undefined {
	const structured = message?.tool_calls?.find((c) => c.type === "function" && c.function?.name === toolName)
		?.function?.arguments;
	if (structured) return structured;
	return extractInlineToolCallArgs(message?.content, toolName);
}
