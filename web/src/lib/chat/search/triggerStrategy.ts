// How the app decides a chat turn needs open-web grounding. Four strategies:
//
//   "heuristic" — the recency regex is the only decider. The function that runs is
//                 isRecencyQueryDenoised, NOT bare isRecencyQuery: runSearch.ts uses
//                 `recency ?? isRecencyQueryDenoised(text)`, and recency.ts defines that as
//                 `isRecencyQuery(text) && !isTechnicalContext(text)`. The de-noise term
//                 is load-bearing and the two disagree on real cases, so measure the
//                 incumbent with the de-noised one.
//   "model"     — a server-side classifier (searchDecision.ts) lets the MODEL
//                 decide; the recency regex decides only when the classifier
//                 gives no verdict. This is "the model doing it" without the
//                 unreliable mid-stream tool-call parsing.
//   "tool"      — real OpenAI tool-calling: searchDecision.decideSearchViaTool offers
//                 the model the web_search tool ($lib/chat/server/search/toolSearch.ts),
//                 and the model decides whether to search and writes the query.
//   "margin"    — the EMBEDDING gate (searchIntent.ts, behind search-intent-embedding-gate): cosine
//                 distance to labelled fresh vs evergreen exemplars, no completions call at all.
//                 Unlike model/tool no regex is consulted at all (CUR-2109). When the gate gives no
//                 verdict the turn searches, and every such turn is a logged
//                 `failopen: search-decision` departure (CUR-2108). The name "margin" is
//                 inherited from an earlier gate that read a yes/no classifier's first-token
//                 LOGPROB margin; its eval parser lives in evals/search-decision/margin.ts, and
//                 evals/search-decision/FINDINGS.md holds that gate's measurements, which do not
//                 describe the embedding gate.
//
//                 The explicit-lookup early return in shouldRunSearch applies to the other
//                 strategies only; here the gate decides explicit asks too.
//
//                 What it buys over the incumbent (isRecencyQueryDenoised) is recall on
//                 recency_unworded questions: they need a search and contain no recency word,
//                 so there is nothing for a regex to match and no threshold recovers them
//                 (the incumbent scores 0/20 on that bucket of the labelled sets).
//                 The win is ONE-directional. The !isTechnicalContext term already suppresses
//                 "current"/"latest" in a coding context, so margin is not rescuing that class,
//                 and a claim that it is measures bare isRecencyQuery instead of the function
//                 that runs. The coding questions the regex still misreads are not a tuning
//                 problem either: TECHNICAL_RE is a hand-written alternation carrying
//                 bash/git/docker but not react/helm/mercurial/zig, and a hand-maintained
//                 vocabulary of tool names cannot cover a space that grows new tool names.
//                 See recency.ts.
// Single switch for the alpha. To make it deploy-tunable without a code change,
// read PUBLIC_SEARCH_TRIGGER here and fall back to this default.
export type SearchTriggerStrategy = "heuristic" | "model" | "tool" | "margin";

// Code default = "heuristic" — the prod-SAFE default. Deployments select the
// active strategy via the PUBLIC_SEARCH_TRIGGER env var (resolved through
// resolveTriggerStrategy below), so flipping strategies is a config change,
// never a code edit that could surprise a deploy. The deployed value can differ per
// environment, so read it from the deployment's config rather than from this comment.
export const SEARCH_TRIGGER_STRATEGY: SearchTriggerStrategy = "heuristic";

/**
 * Resolve a raw env value (PUBLIC_SEARCH_TRIGGER) into a valid strategy, falling
 * back to the safe code default for unset/unknown values. Pure + exported so the
 * client (via layout data) and the server endpoint resolve it identically.
 */
export function resolveTriggerStrategy(raw?: string | null): SearchTriggerStrategy {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "heuristic" || v === "model" || v === "tool" || v === "margin"
		? v
		: SEARCH_TRIGGER_STRATEGY;
}

/**
 * Whether the client should ask the server for a model-driven decision (vs. the recency
 * heuristic alone). True for "model", "tool", and "margin". For model/tool the heuristic stands in
 * when the classifier gives no verdict; for margin it is never read (see shouldRunSearch).
 */
export function usesModelClassifier(
	strategy: SearchTriggerStrategy = SEARCH_TRIGGER_STRATEGY
): boolean {
	return strategy === "model" || strategy === "tool" || strategy === "margin";
}

/**
 * Pure composition of the two signals + strategy. The classifier result is
 * passed in (resolved by the caller, since it needs a server round-trip) so
 * this stays pure and unit-testable. Under model/tool the classifier's verdict decides and the
 * heuristic stands in only when the classifier gave none; under heuristic it is the only decider.
 */
export function shouldRunSearch(opts: {
	heuristicHit: boolean;
	classifierHit?: boolean;
	classifierOk?: boolean;
	strategy?: SearchTriggerStrategy;
	// The user's OWN explicit ask to search/look up/fact-check (isExplicitLookupRequest) — see
	// recency.ts for why this is kept separate from heuristicHit (the topic-based recency regex
	// that's deliberately NOT OR'd into margin below). Checked first for model/tool/heuristic: an
	// explicit ask should never be swallowed by a classifier that only saw a decontextualized
	// follow-up ("why not look online to find out?" carries no topic on its own). Margin ignores it:
	// the embedding gate matches those phrasings against its exemplars itself (CUR-2109).
	explicitLookupHit?: boolean;
}): boolean {
	const strategy = opts.strategy ?? SEARCH_TRIGGER_STRATEGY;
	if (strategy === "margin") {
		// The embedding gate is the only decider; neither regex is consulted (CUR-2109). On the holdout
		// the gate alone gets every bucket the regexes cover, explicit asks included, and the recency
		// regex adds false positives on coding questions it has no vocabulary for.
		// No verdict means SEARCH: Alpha is reported to search too little, so a missed search costs more
		// than an extra one. The caller logs every such turn as a departure.
		return opts.classifierOk === false ? true : !!opts.classifierHit;
	}
	if (opts.explicitLookupHit) return true;
	if (usesModelClassifier(strategy)) {
		// The classifier read the whole question, so its verdict stands; the recency regex decides only
		// when there is none. OR'd ahead of a "no", a bare "now" in "does the chat I'm having now carry
		// over at sign-in?" would send an app question to the web (CUR-2372).
		const verdict = opts.classifierOk !== false && opts.classifierHit !== undefined;
		return verdict ? !!opts.classifierHit : opts.heuristicHit;
	}
	return opts.heuristicHit;
}
