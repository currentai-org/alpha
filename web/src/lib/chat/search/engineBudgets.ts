// Intent-routed per-engine retrieval budgets for the open-web search (#1). Pure + a LEAF module (no
// server/model imports) so the profile table + rescue + rebalance is testable in the hermetic CI gate,
// same as webSearchPlan / triggerStrategy.
//
// The reranker net is capped at RERANK_MAX_BATCH (32); the wide-net defaults sum to exactly 32 and are
// split uniformly across all six engines. Routing redistributes that SAME ≤32 total toward the engines
// that can answer THIS query's intent, and drops engines that can't — a zero budget means the engine is
// NOT launched (openSearch skips the promise), which removes a network round-trip (a likely TTFT win)
// AND frees rerank slots for the relevant engines (a recall win at the same cap).
//
// SAFETY INVARIANTS (unit-tested):
//   • Only routes when `confident` (strict unique-argmax from classifyQueryIntent). Not confident →
//     `general` = today's exact wide-net defaults → zero regression.
//   • Rescue: the SOLE source of any PRESENT secondary signal is preserved at ≥ today's wide-net default
//     (HF is the only released-model source; OpenAlex+arXiv the only scholarly ones), so mixed-intent
//     queries ("latest open-weights release" = news+models) never lose their specialized engine before
//     the reranker runs.
//   • Total ≤ 32 after rescue+rebalance: overflow is deducted from the largest general-web engine
//     (Firecrawl, then Wikipedia) down to a floor of 3.

import type { SearchIntent } from "./queryIntent";

export interface EngineBudgets {
	wikipedia: number;
	wikinews: number;
	firecrawl: number;
	openalex: number;
	arxiv: number;
	huggingface: number;
}

export const RERANK_BATCH_CAP = 32;

/** Today's reranker-ON wide-net defaults (sum = 32). Used for `general` / not-confident → no regression. */
export const WIDE_NET_DEFAULTS: EngineBudgets = {
	wikipedia: 6,
	wikinews: 4,
	firecrawl: 8,
	openalex: 5,
	arxiv: 5,
	huggingface: 4,
};

/** Reranker-OFF tight defaults (unchanged from the pre-routing behavior; the no-reranker path stays
 *  ungrounded and never pays for the wide net). openSearch uses these when reranking is disabled. */
export const NO_RERANK_DEFAULTS: EngineBudgets = {
	wikipedia: 3,
	wikinews: 2,
	firecrawl: 4,
	openalex: 3,
	arxiv: 3,
	huggingface: 2,
};

// Per-intent profiles (reranker-ON). Each sums ≤ 32 BEFORE rescue; rescue + rebalance keeps the post
// total ≤ 32. `general` is the wide-net defaults.
const PROFILES: Record<Exclude<SearchIntent, "general">, EngineBudgets> = {
	// News/policy/releases: reference + open-web + open news dominate; scholarly shrinks; HF drops (0)
	// unless a `models` signal rescues it. Sum = 28.
	news: { wikipedia: 7, wikinews: 6, firecrawl: 9, openalex: 3, arxiv: 3, huggingface: 0 },
	// Scholarly: OpenAlex + arXiv dominate; Wikinews drops. Sum = 27.
	research: { wikipedia: 5, wikinews: 0, firecrawl: 4, openalex: 8, arxiv: 8, huggingface: 2 },
	// Released models: HF dominates; already ≥ defaults for scholarly engines. Sum = 29.
	models: { wikipedia: 6, wikinews: 0, firecrawl: 6, openalex: 4, arxiv: 4, huggingface: 9 },
	// Definitional/encyclopedic: Wikipedia + open web dominate; HF drops (0) unless `models` rescues.
	// Sum = 28.
	reference: { wikipedia: 9, wikinews: 2, firecrawl: 8, openalex: 6, arxiv: 3, huggingface: 0 },
};

const REBALANCE_FLOOR = 3; // never shrink Firecrawl/Wikipedia below this when reclaiming overflow

function sum(b: EngineBudgets): number {
	return b.wikipedia + b.wikinews + b.firecrawl + b.openalex + b.arxiv + b.huggingface;
}

/**
 * Resolve the per-engine budgets for a turn. Pure + deterministic.
 *  - Not confident (or `general`) → WIDE_NET_DEFAULTS (every engine launches; no regression).
 *  - Confident → the intent profile, then RESCUE any present secondary signal's sole source up to its
 *    wide-net default, then REBALANCE any overflow off Firecrawl/Wikipedia (floor 3) to hold ≤ 32.
 */
export function resolveEngineBudgets(opts: {
	intent: SearchIntent;
	confident: boolean;
	signals: Set<SearchIntent>;
}): EngineBudgets {
	if (!opts.confident || opts.intent === "general") {
		return { ...WIDE_NET_DEFAULTS };
	}
	const b: EngineBudgets = { ...PROFILES[opts.intent] };

	// Rescue: a present secondary signal (≠ the primary intent) keeps its sole-source engine at ≥ today's
	// wide-net default. HF is downloads-sorted (a short window silently drops relevant less-popular
	// models), so "≥ default", not a token floor. news/reference are served by the always-launched
	// Wikipedia/Firecrawl and need no rescue.
	if (opts.intent !== "models" && opts.signals.has("models")) {
		b.huggingface = Math.max(b.huggingface, WIDE_NET_DEFAULTS.huggingface);
	}
	if (opts.intent !== "research" && opts.signals.has("research")) {
		b.openalex = Math.max(b.openalex, WIDE_NET_DEFAULTS.openalex);
		b.arxiv = Math.max(b.arxiv, WIDE_NET_DEFAULTS.arxiv);
	}

	// Rebalance: hold the grand total ≤ 32 by reclaiming overflow from the largest general-web engine
	// first (Firecrawl, then Wikipedia), never below the floor. Deterministic.
	let overflow = sum(b) - RERANK_BATCH_CAP;
	for (const engine of ["firecrawl", "wikipedia"] as const) {
		if (overflow <= 0) break;
		const reducible = Math.max(0, b[engine] - REBALANCE_FLOOR);
		const take = Math.min(reducible, overflow);
		b[engine] -= take;
		overflow -= take;
	}
	return b;
}
