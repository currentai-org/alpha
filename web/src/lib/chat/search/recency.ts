// Lightweight, no-LLM heuristic for "this question wants current/external info
// the model can't know from training" — used to surface the "search open
// sources?" affordance in the composer. Deliberately conservative: it only
// *offers* search; the user always decides, and a manual search toggle is
// always available regardless. Client-safe (no server deps). Ported from chat/.

const RECENCY_RE =
	/\b(current(ly)?|latest|recent(ly)?|today|now|this (year|month|week)|right now|as of|up[- ]?to[- ]?date|newest|status of|state of|202[4-9]|203\d|breaking|news|just (happened|announced)|so far)\b/i;

// "how do you find that / can you look that up" — the documented citizen scenario. Bounded gap
// ("check"/"verify"/"confirm" ... "online" within 20 chars) catches "can you check online for the
// steps" / "verify that online" — phrasings the fixed verb list (find/know/look/search) missed.
const LOOKUP_RE =
	/\b(how (do|would|can) you (find|know|look|search)|look (this|that|it) up|search (the web|online|for)|find out|fact[- ]?check|(?:check|verify|confirm)\b[^?.!]{0,20}\bonline)\b/i;

export function isRecencyQuery(text: string): boolean {
	const t = (text ?? "").trim();
	if (t.length < 3) {
		return false;
	}
	return RECENCY_RE.test(t) || LOOKUP_RE.test(t);
}

// Split out from isRecencyQuery so a caller can react to the user's OWN STATED intent to search
// independently of the topic-based RECENCY_RE half. This matters because the "margin" trigger
// strategy (triggerStrategy.ts) deliberately does NOT OR isRecencyQuery/isRecencyQueryDenoised into
// its decision: OR-ing the topic regex drops specificity on the search-decision eval
// (RECENCY_RE trap words like "current"/"latest" in a coding context). That cost belongs to
// RECENCY_RE; LOOKUP_RE (an explicit "look this up" / "check it online" / "fact-check" ask) is not
// part of it (see recency.spec.ts's "documented look-it-up scenario" test). An explicit ask is the
// user's own stated intent, not a topic-volatility guess, so it is a categorically
// lower-false-positive signal and is safe to OR into the margin decision on its own (see
// triggerStrategy.shouldRunSearch).
//
// Without this split, a follow-up like "why not look online to find out?" matches LOOKUP_RE but the
// margin strategy discards it with the rest of isRecencyQuery, and the model repeats its previous
// answer without ever searching.
export function isExplicitLookupRequest(text: string): boolean {
	const t = (text ?? "").trim();
	if (t.length < 3) return false;
	return LOOKUP_RE.test(t);
}

// Coding/technical how-to context: "current/status/latest/now" are false recency
// triggers here ("how do I get the current date in Python?", "git status"). De-noising
// against this raises the heuristic's specificity on the eval (the held-out set
// confirmed it generalizes for the COMMON languages/tools below; it leaks on rarer ones,
// which is acceptable — the model classifier backstops, and a stray search is cheap).
// Keyword list deliberately moderate (not held-out-tuned) — see evals/search-decision.
const TECHNICAL_RE =
	/\b(python|javascript|typescript|java|c\+\+|c#|rust|go(?:lang)?|ruby|php|swift|kotlin|bash|shell|zsh|powershell|sql|git|github|docker|kubernetes|k8s|systemd|linux|unix|npm|node|deno|regex|css|html|json|yaml|api|sdk|cli|terminal|compiler|runtime|function|variable|array|string|integer|command|circuit|resistor|voltage|ohm|capacitor|timestamp|working directory)\b/i;

/** True when the query reads as a coding/technical how-to (where recency words are false
 *  triggers). Pure + exported for testing. */
export function isTechnicalContext(text: string): boolean {
	return TECHNICAL_RE.test((text ?? "").trim());
}

/**
 * De-noised recency heuristic: the recency signal, suppressed when the query is an
 * obvious coding/technical how-to. This is the search fast-path used by the composer —
 * raw isRecencyQuery is kept for any caller that wants the unfiltered signal. In the
 * "model"/"tool" strategy a suppressed-but-actually-current query (e.g. "latest Node.js
 * release") still gets caught by the model classifier, so de-noise only ever removes
 * spurious coding searches, never real ones, in those strategies.
 *
 * That guarantee does NOT extend to "margin", which is the live strategy.
 * triggerStrategy.ts uses `classifierOk === false ? heuristicHit : !!classifierHit`, so on the
 * happy path this function is not consulted at all, and on a FAILED margin call it is the sole
 * decider with no classifier behind it. There a suppressed-but-actually-current query is dropped
 * with nothing to catch it. The one thing that still survives every strategy is the user's
 * explicit ask (isExplicitLookupRequest, checked first in triggerStrategy.ts).
 *
 * Know what the suppression is actually made of before trusting it: TECHNICAL_RE above is a
 * hand-written alternation of ~48 literals. It carries bash, git, docker, npm, "working
 * directory", even "resistor", and it does not carry react, helm, mercurial or zig — which is
 * precisely why those four queries survive de-noise and show up as the residual false-positives
 * in the timeless_spicy bucket (see triggerStrategy.ts). Each is one alternation away
 * from correct, and adding them is the wrong move: a hand-maintained vocabulary of tool names
 * cannot cover a space that keeps growing new tool names. That is the argument for a classifier
 * over a regex stated in the regex's own failure mode.
 */
export function isRecencyQueryDenoised(text: string): boolean {
	return isRecencyQuery(text) && !isTechnicalContext(text);
}

// A year names when something happened, not that the person wants the newest of it: "who won the 2024
// election?" asked in 2026 wants 2024's pages. RECENCY_RE still counts years toward searching at all.
const BARE_YEAR_RE = /\b(202[4-9]|203\d)\b/g;

/** The person wants the latest of something, so the web search also looks at the past year. (CUR-3932)
 *  isRecencyQueryDenoised with bare years ignored. */
export function asksForTheLatest(text: string): boolean {
	return isRecencyQueryDenoised((text ?? "").replace(BARE_YEAR_RE, " "));
}

// Structurally-LIVE query classes the open engines genuinely CAN'T serve: a match in progress, and
// "is it raining" with no place named. For these, even a topically-relevant page (the team's page, the
// last result) is STALE for the ask, so it clears the rerank floor yet would ground a fresh-looking
// citation on dead data. This is the POSITIVE inverse of isTechnicalContext's de-noise: a class where
// grounding must be suppressed even when the engines return a relevant-looking page (L3's
// relevanceVerified is a backstop, but it can't tell a stale-but-relevant page from a current one). A
// false positive costs an honest ungrounded answer (the persona then says "I don't have live X"), and L3
// backstops any false negative. Client-safe (no server deps).
//
// Prices, exchange rates, weather for a named place and headlines are deliberately NOT on this list
// (CUR-2424): Firecrawl's SERP snippets carry today's figure for those (an exchange rate, a gold
// price, a stock quote, a dated forecast), so vetoing them would send a person asking for today's
// euro-to-dirham rate elsewhere instead of searching. A live score is the one class those same
// searches cannot answer: they return team pages and the previous match.
const UNSERVABLE_LIVE_RE = new RegExp(
	[
		// Live sports: the score / who's winning a match in progress (not "test scores", "credit score").
		"\\b(?:live|current|latest|final)\\s+scores?\\b",
		"\\bwhat(?:'?s| is| are)\\s+the\\s+scores?\\b",
		// "who is winning" REQUIRES a concrete sports-context noun within ~30 chars — bare "who is winning"
		// is metaphorical far too often for THIS product ("who is winning the open source AI race / the AI
		// policy debate"), and it would suppress even a manual "always" search. "race"/"battle" are excluded
		// on purpose (arms/space/AI race, culture battle). The bounded gap ([^?.!] can't cross a sentence)
		// lets the noun trail the phrase ("winning the World Cup final"). Score patterns carry the rest.
		"\\bwho(?:'?s| is| are)\\s+winning\\b[^?.!]{0,30}\\b(?:game|match|series|championship|cup|bowl|tournament|final|set|fixture|grand prix|playoffs?|league)\\b",
		"\\bscore\\s+(?:right now|now|so far|of the (?:game|match))\\b",
		// Weather with no place: a search cannot know where "outside" is.
		"\\bis it\\s+(?:raining|snowing|sunny|cloudy)\\b",
	].join("|"),
	"i"
);

/** True when the query asks for structurally-LIVE data (a live score, placeless weather) the open
 *  engines can't serve — so the turn must NOT pretend-search or be stamped
 *  grounded, even under manual "always". Pure + exported for testing. Consumed by webSearchPlan (skips
 *  the web) and buildPersonaPrompt (swaps the "offer to search" recency line for an honest "no live X"). */
export function isUnservableLiveQuery(text: string): boolean {
	const t = (text ?? "").trim();
	if (t.length < 3) return false;
	// De-noise against coding/technical context (the same filter isRecencyQueryDenoised uses): "live",
	// "current", "score", and "price" double as software/UI/finance-modelling terms, so a query carrying
	// explicit technical keywords ("live scores API", "current price field in my schema") is NOT a
	// live-DATA ask and must not be suppressed.
	return UNSERVABLE_LIVE_RE.test(t) && !isTechnicalContext(t);
}
