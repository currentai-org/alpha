// Distill a conversational chat turn down to the core search query before it
// reaches the open-knowledge engines. People type like people — "I need the
// current status of the EU AI Act for a policy briefing next week. How do you
// find that?" — but Wikipedia and Firecrawl rank on the literal string, so the
// framing and the trailing question bury the real entities and can surface a
// stale or off-topic page (observed on the flagship EU-AI-Act demo prompt).
//
// We strip known framing / lookup / purpose clauses DETERMINISTICALLY: no LLM,
// so it's fast, free, and itself transparent (the distilled query is shown to
// the user). It's conservative — if stripping leaves too little, or wouldn't
// shorten the query, we fall back to the original. A query that's already terse
// keywords passes through untouched.

// Trailing ANAPHORIC lookups — the whole clause is filler because it refers
// back to something already said ("how do you find THAT", "look THAT up").
const LOOKUP_TAIL =
	/\b((how|where)\s+(do|would|can|could|should)\s+(you|i|we)\s+(find|know|look|search|check|verify)\s+(that|this|it|them|those)\b[^?.!]*[?.!]?|(look|check)\s+(this|that|it)\s+up\b|find\s+(this|that|it)\s+out\b|fact[-\s]?check\s+(this|that|it)\b)/gi;

// Trailing "…what sources can I check / where can I find more / what can I cite" — a lookup tail asking
// HOW/WHERE to verify. It's filler for retrieval (the real entities are earlier in the turn), and worse,
// the bare word "sources" matches ASTROPHYSICAL sources on arXiv → off-topic physics preprints crowd out
// the on-topic hits. Requires a "(can|should|do…) (i|you|we) (check|find…)"
// core so it only ever strips an actual lookup question, never a substantive "what X" query.
const SOURCE_TAIL =
	/\b(and\s+|,\s*)?(what|which|where|how)\s+(sources?|references?|citations?|links?|info(?:rmation)?|data|evidence|more)?\s*(can|could|should|do|would|might)\s+(i|you|we)\s+(check|find|use|cite|read|consult|verify|trust|look\s+(at|up|into)|go\s+to|refer\s+to)\b[^?.!]*[?.!]?/gi;

// LEADING lookup verb phrases — strip the ask but KEEP the content that follows
// ("can you look up X" -> "X"). Distinct from the anaphoric tails above.
const LOOKUP_LEAD =
	/\b((can|could|would|will)\s+you\s+(please\s+)?(find|look\s+up|look\s+into|search\s+for|search|check|tell\s+me)\s+|please\s+(find|look\s+up|search\s+for|search)\s+|find\s+out\s+|look\s+up\s+)/gi;

// First-person framing leads — "I need to know the", "can you help me understand".
//
// A self-description is NOT framing and stays in the query. "I'm a tenant in England and my landlord
// wants to evict me. What are my rights?" must not distill to "What are my rights", which a search engine
// answers with US know-your-rights pages (CUR-2423). "I'm a …", "I work in …" and "As a …,"
// name who is asking and where, which is what a rights, rules or procedures question turns on.
const FRAMING =
	/\b(i\s+(need|want|'?d\s+like|would\s+like|am\s+looking)\s+(to\s+(know|find|understand|see)\s+)?(the|a|an|out\s+about)?\s*|can\s+you\s+(help\s+me\s+)?(understand|tell\s+me|explain|figure\s+out)\s+)/gi;

// Purpose / time / politeness adjuncts that don't help retrieval.
const ADJUNCT =
	/\b(for\s+(a|an|my|our)\s+[^.,?]+|next\s+(week|month|year|quarter)|this\s+(season|quarter)|right\s+now|please|thank\s*you|thanks)\b/gi;

function tidy(s: string): string {
	return s
		.replace(/\s+/g, " ")
		.replace(/^[\s.,;:?!'"-]+|[\s.,;:?!'"-]+$/g, "")
		.replace(/^(the|a|an)\s+/i, "")
		.trim();
}

export function distillQuery(text: string): string {
	const original = (text ?? "").trim();
	if (original.length < 12) {
		// Already short — almost certainly keywords, not prose. Don't risk it.
		return original;
	}

	const distilled = tidy(
		original
			.replace(SOURCE_TAIL, " ")
			.replace(LOOKUP_TAIL, " ")
			.replace(FRAMING, " ")
			.replace(LOOKUP_LEAD, " ")
			.replace(ADJUNCT, " ")
	);

	// Guardrails: never return something empty, too small, or not actually
	// shorter than what we started with — in any of those cases the strippers
	// either over-trimmed or found nothing useful, so keep the user's words.
	const words = distilled.split(/\s+/).filter(Boolean);
	if (words.length < 2 || distilled.length < 6 || distilled.length >= original.length) {
		return original;
	}
	return distilled;
}
