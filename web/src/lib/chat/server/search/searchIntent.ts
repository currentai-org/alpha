// An EMBEDDING search-trigger gate, in place of an LLM yes/no classifier read through logprobs.
//
// WHY NOT LOGPROBS: behind a gateway with a fallback ladder, models differ in how they answer a
// `logprobs: true` request. One returns an EMPTY array (HTTP 200, no error of any kind), another
// refuses the request and falls through, and only some return numbers. So a logprob gate (CUR-2108)
// gets usable numbers only from certain rungs, against a threshold calibrated for a different model;
// the threshold's model can change underneath it without anyone changing the threshold (the same
// shape as CUR-113).
//
// An embedding gate takes the decision off the completions API entirely. There is no fallback ladder
// on a feature-extraction call, so there is no model to substitute, nothing to calibrate against a
// moving target, and no 504. It is also DETERMINISTIC: the same query yields the same verdict, which
// an LLM gate does not.
//
// TWO-SIDED, NOT A BARE THRESHOLD. The score is (closest fresh example) − (closest evergreen example)
// rather than a raw cosine against the fresh set. On the same held-out set the LLM gate was
// scored on, with the threshold fitted by leave-one-out on the TRAIN split and then applied untouched:
//
//                                       recall   specificity
//     embedding, two-sided margin        100%        88%
//     embedding, fresh-side only          92%        88%   (fitted ON the holdout, so flattered)
//     LLM logprob gate (CUR-2108)         96%        86%
//
// Read that as "at least as good", not as a win: the holdout is 50 cases, so each percentage point is
// half a query. What it is unambiguously better at is not depending on which model the gateway
// serves.
//
// THE EXEMPLARS ARE THE MODEL, AND THEY ARE THE TRAIN SPLIT VERBATIM. data/searchFreshExamples.json
// and data/searchEvergreenExamples.json are evals/search-decision/cases.jsonl, split by label. That
// makes cases.jsonl USELESS as a test set for this gate — it is the classifier, so it would score
// near-perfectly and mean nothing. Only cases_holdout.jsonl is a real measurement, and
// scripts/calibrate-search-intent.mjs refuses to report a number from cases.jsonl for that reason.
// When you add a phrasing to fix a miss, add it from a real conversation or from the train split —
// never from the holdout, or the next number is fiction.

import { precomputedGuardVecs } from "$lib/chat/server/guardVectors";
import { embedText, embedTexts, maxCosine } from "$lib/chat/server/rag/embed";
import { embeddingModel } from "$lib/chat/server/rag/env";
import { logger } from "$lib/chat/server/logger";
import { flagEnabledOr } from "$lib/chat/server/flags";

import FRESH_EXAMPLES from "$lib/chat/server/data/searchFreshExamples.json";
import EVERGREEN_EXAMPLES from "$lib/chat/server/data/searchEvergreenExamples.json";

/** PostHog key gating this migration. Registered in flagKeys.ts with what it gates and what its
 *  absence means. */
export const SEARCH_INTENT_EMBEDDING_GATE_FLAG = "search-intent-embedding-gate";

/**
 * Operating point, fitted by LEAVE-ONE-OUT on evals/search-decision/cases.jsonl and then applied
 * unchanged to cases_holdout.jsonl (100% recall, 88% specificity there).
 *
 * Calibrated PER EMBEDDING MODEL — a two-sided cosine margin is not comparable across models. See
 * CALIBRATED_FOR_MODEL below for what enforces that.
 */
const SEARCH_INTENT_THRESHOLD = -0.0179;

/**
 * The embedding model SEARCH_INTENT_THRESHOLD was fitted against.
 *
 * This constant guards against a threshold outliving its model. A cosine margin is
 * a number in one model's vector space; carried to another model's space it is not a weaker signal,
 * it is a meaningless one. precomputedGuardVecs already refuses vectors built by a different model, so
 * a swap degrades to a runtime embed — but that produces vectors in the NEW space and would then
 * compare them against THIS threshold, which is how a threshold goes stale against a changed
 * checkpoint (as in CUR-113).
 *
 * So on a mismatch this gate returns no opinion, and under margin a turn with no opinion searches
 * (triggerStrategy.ts), rather than getting a confident verdict computed in the wrong units. Re-run pnpm calibrate:search-intent after
 * any embedding-model change and move both constants together, in one commit.
 */
const CALIBRATED_FOR_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

/** Set names in data/guard-vectors.json. Must match the keys in scripts/build-guard-vectors.mjs. */
const FRESH_SET = "search_fresh";
const EVERGREEN_SET = "search_evergreen";

/** PostHog, not an env var, because this is a MIGRATION gate and not a standing choice between two
 *  supported gates. What a rollout needs is a percentage, a minute-scale rollback with no redeploy,
 *  and one place to watch — none of which a deploy-time string gives you. Same shape as
 *  mathRouting.ts's `mathRoutingEnabled`.
 *
 *  There is no logprob gate to fall back to (CUR-2108), so with the flag off
 *  "margin" has no decider at all: every automatic turn that reaches it searches
 *  (triggerStrategy.ts, CUR-2109) and is logged as a `failopen: search-decision` departure. Delete
 *  this and the flag key once the rollout holds. */
export function searchIntentEnabled(): boolean {
	return flagEnabledOr(SEARCH_INTENT_EMBEDDING_GATE_FLAG, () => false);
}

/**
 * PURE: the two-sided margin. Positive means the query looks more like something needing fresh
 * information than like something answerable from the model's own weights.
 *
 * Pure and I/O-free so the scoring can be unit-tested against fixtures independently of the network
 * call that produces the vectors — same split the rest of this subsystem uses (marginFromLogprobs,
 * classifyVector).
 */
function freshnessMargin(
	query: readonly number[],
	fresh: readonly (readonly number[])[],
	evergreen: readonly (readonly number[])[]
): number {
	return maxCosine(query, fresh) - maxCosine(query, evergreen);
}

type ExemplarVectors = { fresh: number[][]; evergreen: number[][] };

// Precomputed vectors are the normal path and cost zero embeds. The runtime fallback below exists for
// the case precomputedGuardVecs is designed to catch — artifact built with a different embedding model,
// or an exemplar file edited without rebuilding — and is cached per process so a fallback is paid once
// rather than per turn.
let runtimeVectors: ExemplarVectors | null = null;

async function exemplarVectors(): Promise<ExemplarVectors | null> {
	const pre = {
		fresh: precomputedGuardVecs(FRESH_SET, FRESH_EXAMPLES),
		evergreen: precomputedGuardVecs(EVERGREEN_SET, EVERGREEN_EXAMPLES),
	};
	if (pre.fresh && pre.evergreen) return { fresh: pre.fresh, evergreen: pre.evergreen };

	if (runtimeVectors) return runtimeVectors;
	logger.warn(
		{ leg: "search-intent", precomputed: false },
		"[search-intent] precomputed exemplar vectors unusable (model swap, or an exemplar file edited without running build-guard-vectors) — embedding them at runtime once for this process"
	);
	// ONE batched call for both sides, so the fallback costs one request rather than two.
	const all = await embedTexts([...FRESH_EXAMPLES, ...EVERGREEN_EXAMPLES]);
	if (!all) return null;
	runtimeVectors = {
		fresh: all.slice(0, FRESH_EXAMPLES.length),
		evergreen: all.slice(FRESH_EXAMPLES.length),
	};
	return runtimeVectors;
}

export type SearchIntentVerdict = {
	shouldSearch: boolean;
	ok: boolean;
	margin: number;
	/** Why there is no opinion, when `ok` is false. A fixed token, so it groups in a query. */
	reason?: "empty-query" | "uncalibrated-embedder" | "no-vector" | "threw";
};

/**
 * Decide whether `text` needs fresh web information.
 *
 * `ok: false` means "this gate has no opinion", with `reason` saying why. The caller records that as a
 * fail-open departure before falling back (CUR-2108). It is never a "no" — a degraded
 * embedding endpoint must not silently turn search triggering off, which would be indistinguishable
 * from deciding that nothing on earth needs searching.
 *
 * COST: at most one embedding round-trip per turn, and normally zero. `embedText` is memoized in the
 * process-wide LRU (rag/embedCache.ts, keyed on model + case/whitespace-normalized text), and with
 * RAG_ENABLED=true rag/localStore.ts already embeds the same user turn on the same key every turn. The
 * exemplars come from the committed artifact, so they cost nothing at any point, including cold start.
 */
export async function decideSearchViaIntent(
	text: string,
	threshold = SEARCH_INTENT_THRESHOLD
): Promise<SearchIntentVerdict> {
	const q = (text ?? "").trim();
	if (!q) return { shouldSearch: false, ok: false, margin: 0, reason: "empty-query" };
	const active = embeddingModel();
	if (active !== CALIBRATED_FOR_MODEL) {
		logger.error(
			{ leg: "search-intent", activeModel: active, calibratedFor: CALIBRATED_FOR_MODEL },
			"[search-intent] the embedding model changed and the threshold did not — declining to decide, so every margin turn searches until pnpm calibrate:search-intent is re-run"
		);
		return { shouldSearch: false, ok: false, margin: 0, reason: "uncalibrated-embedder" };
	}
	try {
		const [qVec, ex] = await Promise.all([embedText(q), exemplarVectors()]);
		if (!qVec || !ex) return { shouldSearch: false, ok: false, margin: 0, reason: "no-vector" };
		const margin = freshnessMargin(qVec, ex.fresh, ex.evergreen);
		logger.info({ leg: "search-intent", margin, threshold }, "[search-intent] verdict");
		return { shouldSearch: margin >= threshold, ok: true, margin };
	} catch (e) {
		logger.warn({ err: e, leg: "search-intent" }, "[search-intent] classification failed");
		return { shouldSearch: false, ok: false, margin: 0, reason: "threw" };
	}
}
