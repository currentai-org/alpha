// Small per-engine TRUST + RECENCY prior for the open-web rerank (#4). Pure + a LEAF module so it's
// testable with an injected reference date (never Date.now() inside the unit). openSearch turns this into
// applyRerank's `scoreAdjust` closure — and applyRerank applies scoreAdjust ONLY to survivors AFTER the
// absolute + relative floors, so a prior can never re-admit a below-floor page; it only reorders the
// already-admitted top-K.
//
// FLAG-GATED OFF by default (openSearch reads GROUND_SCORE_PRIOR): BGE relevance is bimodal/sharp, so a
// real relevance gap dominates a small prior — the prior only ever breaks NEAR-TIES, which is the intent.
// The magnitude is expressed as a FRACTION of the raw score (not a flat additive) so it can't dominate a
// low-score survivor.

import type { SearchEngine } from "$lib/chat/types/Search";

// Trust multiplier as a fractional delta: Wikipedia/OpenAlex are authoritative (+), Firecrawl is the
// broader open web (−), arXiv/Wikinews/Hugging Face are neutral (0). Sized to only reorder
// near-ties among high scorers.
const TRUST_PCT: Record<SearchEngine, number> = {
	Wikipedia: 0.05,
	OpenAlex: 0.05,
	Firecrawl: -0.05,
	arXiv: 0,
	Wikinews: 0,
	"Hugging Face": 0,
	// The page a person linked, read directly when Firecrawl couldn't — the same open web. (CUR-2152)
	Direct: -0.05,
	// Unmeasured against ours; neutral until the head-to-head says otherwise. (CUR-2420)
	Mistral: 0,
};

const DAY_MS = 86_400_000;
const FRESH_DAYS = 365; // ≤ 1y → fresh bonus
const STALE_DAYS = 1825; // > 5y → stale penalty
const RECENCY_PCT = 0.03; // fractional bonus/penalty magnitude for the recency leg

/**
 * Fractional score adjustment for one source. Returns a DELTA to add to `rawScore` (so the effective
 * score becomes `rawScore * (1 + trust + recency)`). Pure; `nowMs` is the injected reference instant.
 *
 * Recency leg only engages when `recency` is true (a recency-flagged turn):
 *  - dated & ≤1y old → +RECENCY_PCT; dated & >5y old → −RECENCY_PCT; in between → 0.
 *  - UNDATED → −RECENCY_PCT, EXCEPT Wikinews, which omits `asOf` BY DESIGN (its MediaWiki `touched` is a
 *    maintenance timestamp, not a publish date) — "undated-by-design" must not be read as "stale", so
 *    Wikinews gets no undated penalty.
 */
export function sourcePrior(
	source: { engine: SearchEngine; asOf?: string },
	rawScore: number,
	opts: { recency: boolean; nowMs: number }
): number {
	let pct = TRUST_PCT[source.engine] ?? 0;
	if (opts.recency) {
		pct += recencyPct(source, opts.nowMs);
	}
	return rawScore * pct;
}

function recencyPct(source: { engine: SearchEngine; asOf?: string }, nowMs: number): number {
	const iso = source.asOf?.slice(0, 10);
	const t = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(t)) {
		// Undated. Wikinews omits asOf by design → no penalty; everything else that could carry a date but
		// doesn't (e.g. Firecrawl) takes the stale penalty on a recency turn.
		return source.engine === "Wikinews" ? 0 : -RECENCY_PCT;
	}
	const ageDays = (nowMs - t) / DAY_MS;
	if (ageDays <= FRESH_DAYS) return RECENCY_PCT;
	if (ageDays > STALE_DAYS) return -RECENCY_PCT;
	return 0;
}
