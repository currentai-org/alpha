// Deterministic, no-LLM per-engine query shaping (#5a). The single distilled query is a compromise: the
// entity-indexed engines (Wikipedia/Wikinews) rank best on the bare entity, while the keyword/abstract
// engines (Firecrawl/OpenAlex/arXiv) and the registry (Hugging Face) do better with the full distilled
// string. So we lightly reshape ONLY for the entity engines, and pass the distilled base through
// unchanged everywhere else. Zero latency; conservative guardrails identical in spirit to distill.ts —
// if reshaping would over-trim (or not change the string) we keep the base.

import type { SearchEngine } from "$lib/chat/types/Search";

// Leading question/definition framing that buries the entity for a title-indexed lookup
// ("what is the eu ai act" → "eu ai act"). distillQuery already removes conversational framing; this is
// the narrower title-lookup cleanup for the entity engines only.
const LEADING_QUESTION =
	/^(what(?:'?s| is| are| was| were)|who(?:'?s| is| are| was| were)|tell me about|explain (?:what )?|define|definition of|overview of|introduction to|background on)\s+/i;

/** Shape the distilled `base` query for a specific engine. Entity engines (Wikipedia/Wikinews) get the
 *  leading question framing + trailing punctuation stripped; all other engines get `base` unchanged.
 *  Guardrail: the reshaped string must keep ≥2 tokens AND actually differ, else return `base`. Pure. */
export function shapeQueryForEngine(base: string, engine: SearchEngine): string {
	const b = (base ?? "").trim();
	if (engine !== "Wikipedia" && engine !== "Wikinews") return b;
	const shaped = b
		.replace(LEADING_QUESTION, "")
		.replace(/[?.!]+$/g, "")
		.replace(/^(the|a|an)\s+/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const tokens = shaped.split(/\s+/).filter(Boolean);
	if (tokens.length < 2 || shaped.length < 3 || shaped.toLowerCase() === b.toLowerCase()) {
		return b;
	}
	return shaped;
}
