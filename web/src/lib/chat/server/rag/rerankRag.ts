// Cross-encoder relevance gate for RAG grounding — the SAME open BGE reranker (RERANK_MODEL) the
// open-web search path uses (search/rerank.ts), applied to ALL merged RAG hits (local catalog + admin
// community + federated SyftHub) in ONE pass, so every source shares one relevance floor and one
// cross-source ordering.
//
// WHY EVERY SOURCE IS RERANKED, SyftHub INCLUDED. rerankByRelevance scores `title + snippet`, and that
// `snippet` is the EXACT 480-char text mergeRagEvidence puts in the prompt as the citable evidence. So the
// reranker judges the very text that will ground the answer: a hit whose snippet scores below the floor
// provides off-topic EVIDENCE — full stop — regardless of any relevant passage buried in the source's
// untruncated tail, because that tail never enters the prompt. (Keeping SyftHub/admin
// hits regardless of score, to avoid "false-dropping" a doc whose head snippet is generic but whose tail
// matched, would only surface a citation to a snippet the model can't use, and clearly-irrelevant
// federated docs would ground replies like a "whats up bro" greeting. Scoring the snippet that
// actually grounds the answer is the honest gate.) SyftHub's own server-side rerank + similarityThreshold is a coarser bi-encoder signal; the
// cross-encoder is strictly a better relevance judge over the same evidence text.
//
// POLICY (differs from web search's hard verified-gate):
//   • Reranker ENABLED + it VERIFIES → the cross-encoder is authoritative: hits are reordered and dropped
//     below RAG_RERANK_MIN_SCORE. A verified all-below-floor result is [] → the caller answers UNGROUNDED
//     (honest "nothing relevant" — this is what drops the off-topic catalog AND federated hits).
//   • Reranker ENABLED but UNVERIFIED (cold/failed/timeout/malformed) → DEGRADE to the input hits
//     unchanged (they already cleared a floor upstream: cosine ≥ RAG_MIN_SCORE, or the SyftHub rerank +
//     similarityThreshold). relevanceVerified=false. So in a deploy with no warm reranker the behavior is
//     unchanged until RERANK_ENDPOINT_URL is wired.
//   • Reranker DISABLED (RERANK_MODEL empty), or nothing to score → pass-through unchanged.
//
// relevanceVerified is PROVENANCE (server-local on RagContext; ragProvenance + the MessageRag wire update
// both drop it): true IFF the cross-encoder actually vetted this turn's hits. It is the RAG analog of
// WebSearchOutcome.relevanceVerified but, per the chosen policy, is NOT a hard grounding gate — grounding
// on the degrade path stands on the cosine/similarity floor.

import type { RagSource } from "$lib/chat/types/Rag";
import { rerankByRelevance, rerankEnabled } from "$lib/chat/server/search/rerank";
import { ragRerankMinScore, ragRerankSkipBelow, ragRerankTimeoutMs } from "./env";
import { logger } from "$lib/chat/server/logger";
import { failOpenDeparture } from "$lib/chat/server/failOpen";

export type RerankedRagHits = {
	hits: Omit<RagSource, "n">[];
	/** True IFF the cross-encoder actually scored this turn's hits (never on the disabled/degrade path). */
	relevanceVerified: boolean;
};

/** Rerank the merged RAG hits by cross-encoder relevance and report whether relevance was VERIFIED.
 *  See the module header for the enabled/verified/degrade policy and why every source (SyftHub included)
 *  is reranked on its snippet. FAIL-OPEN: any unverified or thrown outcome returns the input hits
 *  UNCHANGED (never fewer), so RAG grounding can only regress on a VERIFIED all-below-floor result —
 *  never on an infra failure. */
export async function rerankRagHits(
	query: string,
	hits: Omit<RagSource, "n">[]
): Promise<RerankedRagHits> {
	// Disabled, or nothing to score → today's behavior: the cosine/similarity floor already applied
	// upstream is the relevance gate, and we never claim cross-encoder verification.
	if (!rerankEnabled() || hits.length === 0) {
		return { hits, relevanceVerified: false };
	}
	// TTFT skip-floor (opt-in, default off): when EVERY hit carries a store-reported score under
	// RAG_RERANK_SKIP_COSINE_BELOW, declare the turn off-topic without paying the cross-encoder
	// round-trip — a chit-chat turn otherwise spends ~0.4s of rerank just to confirm `kept: 0`.
	// Conservative on purpose: one hit with a MISSING score, or at/above the floor, runs the full
	// rerank. relevanceVerified stays false — the cross-encoder never scored this turn, the upstream
	// similarity did. Calibrate the floor from the bestScore field on the caller's gate logs.
	const skipBelow = ragRerankSkipBelow();
	if (skipBelow > 0 && hits.every((h) => typeof h.score === "number" && h.score < skipBelow)) {
		logger.info(
			{
				retrieved: hits.length,
				bestScore: hits.reduce((m, h) => Math.max(m, h.score ?? 0), 0),
				skipBelow,
			},
			"[rag] every hit is below the similarity skip-floor — skipping the rerank, answering ungrounded"
		);
		return { hits: [], relevanceVerified: false };
	}
	try {
		const rr = await rerankByRelevance(query, hits, {
			minScore: ragRerankMinScore(),
			// Gate path: a VERIFIED all-below-floor result comes back as [] (→ the caller answers
			// ungrounded), never the raw input order. On the UNVERIFIED path this same [] is discarded below.
			allowEmpty: true,
			timeoutMs: ragRerankTimeoutMs(),
		});
		// Verified → the cross-encoder is authoritative (rr.items may be [] = nothing cleared the floor).
		// Unverified (cold/failed/timeout) → DEGRADE to the input hits (already floored upstream); rr.items
		// is the allowEmpty [] here, so ignore it and keep the cosine/similarity result rather than none.
		return rr.verified
			? { hits: rr.items, relevanceVerified: true }
			: { hits, relevanceVerified: false };
	} catch (e) {
		// rerankByRelevance is internally try/caught and shouldn't reject, but the RAG fail-open contract is
		// STRICT (this is an additive feature): a thrown reranker — or a config/key read that throws before
		// its try — must DEGRADE to the cosine/similarity-floored hits, never reject maybeRagGrounding's
		// promise (which the orchestrator does not wrap, and which would error the whole turn).
		logger.warn(e, "[rag] rerank threw; degrading to the cosine/similarity floor");
		failOpenDeparture("rag-rerank", "threw", { hits: hits.length });
		return { hits, relevanceVerified: false };
	}
}
