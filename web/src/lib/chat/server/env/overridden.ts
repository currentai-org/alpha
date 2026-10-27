import { logger } from "$lib/chat/server/logger";

// Make STRUCTURAL config precedence visible — the case where setting one env var makes ANOTHER one
// irrelevant, so someone reading the config forms a wrong model of what the system is doing.
//
// WHY THIS IS ITS OWN THING, and not firstKey. firstKey covers "try A, else B" chains and already warns
// when it falls past position 0. It is the wrong tool here for two reasons: the losing key is often a
// DIFFERENT concept (RERANK_ENDPOINT_URL vs RERANK_KIND — a URL beating a mode name), and firstKey's
// warning fires on every designed fallback, which makes it too noisy to read when the
// fallback is the intended configuration (CUR-60).
//
// THE RULE THAT KEEPS THIS QUIET: log only when the loser was ACTUALLY SET. Nothing overridden, nothing
// logged. So the line appears exactly when a human's mental model is wrong — someone set a value that
// does nothing — and never during normal operation. That is the opposite of firstKey's problem.
//
// Example (CUR-112): with RERANK_KIND=hf and RERANK_ENDPOINT_URL both set, reranking goes over TEI and
// the `hf` setting never applies. Nothing else surfaces that: env:audit sees a non-empty key, and
// env-drift sees prd and preview agreeing. Only the decision site knows, so the decision site logs.
//
// ONCE PER PROCESS per decision. These are cold-start facts, not per-request ones — repeating them on
// every turn would recreate the noise this is designed to avoid.

const announced = new Set<string>();

/** Reset between tests. Not for production use. */
export function _resetOverrideLog(): void {
	announced.clear();
}

/**
 * Record that `decision` resolved to `value` because `winner` was set, and say so ONLY if one of
 * `losers` was also set and therefore ignored.
 *
 * @param decision  Stable dotted name for the choice, e.g. "rerank.transport". Greppable.
 * @param value     What the decision actually resolved to.
 * @param winner    The env var that decided it.
 * @param losers    Env vars that are now inert, as [name, value] pairs — pass the resolved value so
 *                  this module never reads config itself (callers already have it, and a second read
 *                  path is a second thing to get wrong).
 */
export function noteOverridden(
	decision: string,
	value: string,
	winner: string,
	losers: [string, string | undefined][]
): void {
	const ignored = losers.filter(([, v]) => (v ?? "").trim() !== "").map(([k]) => k);
	if (ignored.length === 0) return; // nothing was overridden — stay silent
	if (announced.has(decision)) return;
	announced.add(decision);
	logger.warn(
		{ decision, value, winner, ignored },
		`[config] ${decision}=${value} via ${winner} — ${ignored.join(", ")} set but IGNORED`
	);
}
