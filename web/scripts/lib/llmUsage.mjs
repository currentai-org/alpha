import { basename } from "node:path";

/**
 * One stderr line per model call, token counts only, so a CI log or a local run shows which
 * caller spends what on the QA key. The billing export is per day and per key, and the callers
 * on that key are otherwise indistinguishable in it. Never pass content: the line carries the
 * caller's script name, a short tag, the model and the four counts.
 *
 * Accepts the raw Messages API `usage` block or the already-summarised shape
 * (`summarizeUsage` in critique-journey.mjs). Silent on a missing usage block.
 */
export function logLlmUsage(tag, model, usage) {
	if (!usage) return;
	const line = {
		caller: basename(process.argv[1] ?? "unknown").replace(/\.[cm]?[jt]s$/, ""),
		tag: tag ?? null,
		model: model ?? null,
		input: usage.input ?? usage.input_tokens ?? 0,
		cacheWrite: usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0,
		cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens ?? 0,
		output: usage.output ?? usage.output_tokens ?? 0,
	};
	console.error(`[llm-usage] ${JSON.stringify(line)}`);
}
