// Deterministic, no-LLM query-intent classifier — mirrors recency.ts (pure regex, client-safe, zero
// latency). Used to ROUTE the open-web engine budgets (engineBudgets.ts) so a query spends its ≤32
// rerank-batch slots on the engines that can actually answer it, instead of firing all six uniformly.
//
// WHY DETERMINISTIC. The web-grounded TTFT critical path is already serial (margin-decision LLM →
// coreference-rewrite LLM → engines → rerank); a classifier LLM call here would tax every grounded
// turn. Regex over the already-computed search string is microseconds and adds no round-trip, the same
// reason isRecencyQueryDenoised / isUnservableLiveQuery are regex.
//
// PRECEDENCE IS A STRICT UNIQUE-ARGMAX (no fuzzy "dominant"): each intent scores the number of DISTINCT
// keyword groups it matches; the classifier is `confident` only when exactly one intent holds the max
// and that max ≥ 1. Any tie routes to `general` (the uniform net — every engine launches, so nothing is
// dropped). `signals` is the FULL set of present intents (regardless of confidence) — engineBudgets uses
// it to keep a specialized engine alive when a secondary intent is present (the mixed-intent rescue).

export type SearchIntent = "news" | "research" | "models" | "reference" | "general";

/** The four specialized intents, in a stable order (used for deterministic tie inspection in tests). */
export const SPECIALIZED_INTENTS: readonly Exclude<SearchIntent, "general">[] = [
	"news",
	"research",
	"models",
	"reference",
] as const;

// Each intent is a LIST of independent keyword groups; an intent's score is how many DISTINCT groups
// match (so "latest model release" scores `models` on both the model group and the release group only if
// they are separate groups — one hit per group, capped at the group count). Groups are deliberately
// non-overlapping within an intent so the count is a real breadth-of-signal measure, not keyword spam.
const INTENT_GROUPS: Record<Exclude<SearchIntent, "general">, RegExp[]> = {
	// Current events / policy / releases / announcements — things a static catalog can't hold.
	news: [
		/\b(latest|recent(ly)?|current(ly)?|today|this (?:year|month|week)|as of|up[- ]?to[- ]?date|newest|breaking|so far|just (?:announced|released|happened)|202[4-9]|203\d)\b/i,
		/\b(news|headline|announcement|announced|press release|update|developments?)\b/i,
		/\b(policy|regulation|regulatory|legislation|act|bill|law|ruling|sanction|election|government)\b/i,
	],
	// Scholarly / methodological — papers, studies, benchmarks, datasets, SOTA.
	research: [
		/\b(paper|papers|preprint|arxiv|study|studies|research|survey|literature)\b/i,
		/\b(benchmark|benchmarks|eval(?:uation)?s?|dataset|datasets|leaderboard|sota|state[- ]of[- ]the[- ]art)\b/i,
		/\b(method|methodology|architecture|algorithm|theorem|proof|ablation|empirical)\b/i,
	],
	// Released open models / checkpoints / weights — HF is the sole engine for these.
	models: [
		/\b(model|models|llm|llms|checkpoint|checkpoints|fine[- ]?tun(?:e|ed|ing)|base model|foundation model)\b/i,
		/\b(open[- ]?weights?|open[- ]?source model|weights?|gguf|safetensors|quantiz(?:ed|ation)|adapter|lora)\b/i,
		/\b(released?|release|available on (?:hugging ?face|hf|the hub)|hugging ?face|model card)\b/i,
	],
	// Definitional / encyclopedic / historical — Wikipedia's home turf.
	reference: [
		/\b(what (?:is|are|was|were)|who (?:is|are|was|were)|define|definition|meaning of|explain what)\b/i,
		/\b(history|history of|origin of|founded|invented|discovered|biography|encyclopedi)\b/i,
		/\b(overview of|introduction to|background on|basics of)\b/i,
	],
};

/**
 * Classify a search query's intent deterministically. Returns:
 *  - `signals`: the SET of specialized intents with ≥1 matching keyword group (used for rescue budgets).
 *  - `intent`: the strict unique-argmax specialized intent, or "general" on a tie / no signal.
 *  - `confident`: true iff exactly one intent holds the (≥1) max — i.e. `intent !== "general"`.
 * Pure + client-safe (no server deps). Bias to `general`/not-confident on ties, so ambiguous queries
 * fall back to the uniform engine net rather than risk dropping a needed engine.
 */
export function classifyQueryIntent(text: string): {
	intent: SearchIntent;
	signals: Set<SearchIntent>;
	confident: boolean;
} {
	const q = (text ?? "").trim();
	const signals = new Set<SearchIntent>();
	if (q.length < 3) {
		return { intent: "general", signals, confident: false };
	}
	const scores: Record<Exclude<SearchIntent, "general">, number> = {
		news: 0,
		research: 0,
		models: 0,
		reference: 0,
	};
	for (const intent of SPECIALIZED_INTENTS) {
		let count = 0;
		for (const group of INTENT_GROUPS[intent]) {
			if (group.test(q)) count++;
		}
		scores[intent] = count;
		if (count > 0) signals.add(intent);
	}
	const max = Math.max(...SPECIALIZED_INTENTS.map((i) => scores[i]));
	if (max < 1) {
		return { intent: "general", signals, confident: false };
	}
	const winners = SPECIALIZED_INTENTS.filter((i) => scores[i] === max);
	// Strict unique-argmax: a tie is NOT confident → route to the uniform net (general), which launches
	// every engine so no specialized source is dropped when we can't cleanly disambiguate.
	if (winners.length !== 1) {
		return { intent: "general", signals, confident: false };
	}
	return { intent: winners[0], signals, confident: true };
}

/** Union two signal sets (raw-text signals ∪ finalized-query signals). Recall-safe: only ADDS rescue
 *  triggers, never removes a finalized-query launch. `undefined` raw signals → the finalized set. */
export function unionSignals(
	raw: Set<SearchIntent> | undefined,
	finalized: Set<SearchIntent>
): Set<SearchIntent> {
	if (!raw || raw.size === 0) return finalized;
	return new Set<SearchIntent>([...finalized, ...raw]);
}
