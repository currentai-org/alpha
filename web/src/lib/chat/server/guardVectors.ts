// Precomputed STATIC guard-example vectors. The semantic guards
// (localitySemantic.ts, semanticHedge.ts) each match a user turn against a FIXED set of example
// phrasings by cosine. Those example sets never change per-turn, so embedding them at runtime is a
// pure cold-start tax — the first turn on a fresh instance pays an extra batched embed (and, when the
// embeddings lane is cold, a multi-second stall) before the guard can run. Embedding them at BUILD
// time instead (scripts/build-guard-vectors.mjs → data/guard-vectors.json, committed like rag-index)
// leaves at most ONE runtime embed on the guard path: the user's own query.
//
// FAIL-OPEN, exactly like localStore.ts's identity guard: the precomputed vectors are only usable when
// they were embedded with the ACTIVE model (else they're not comparable to a fresh query embed) AND
// their stored texts still match the caller's live example set (else an edit-without-rebuild would
// serve stale vectors for the wrong phrasings). On any mismatch this returns null and the caller falls
// back to a runtime `embedTexts(examples)` — byte-for-byte today's behavior, just not precomputed.

import guardVectorsRaw from "./data/guard-vectors.json";
import { embeddingModel } from "./rag/env";

type GuardSet = { texts: string[]; vectors: number[][] };
type GuardVectorsFile = {
	model: string;
	dim: number;
	builtAt: string;
	sets: Record<string, GuardSet>;
};

const gv = guardVectorsRaw as GuardVectorsFile;

/** Precomputed example vectors for a named guard set, or `null` when the committed artifact can't be
 *  trusted for this call. Trusted requires: the artifact was built with the ACTIVE embedding model
 *  (`gv.model === embeddingModel()` — the same guard queryLocalStore applies to rag-index), the set
 *  exists and is non-empty, its stored `texts` deep-equal the caller's current `texts` (drift guard),
 *  and every vector matches the recorded dimension. `null` ⇒ caller runtime-embeds `texts` as before. */
export function precomputedGuardVecs(setName: string, texts: string[]): number[][] | null {
	if (!gv || gv.model !== embeddingModel()) {
		return null;
	}
	const set = gv.sets?.[setName];
	if (!set || !Array.isArray(set.vectors) || set.vectors.length === 0) {
		return null;
	}
	// Drift guard: the committed vectors correspond to a SPECIFIC ordered text list. If the live example
	// set was edited (added/removed/reworded a phrasing) without a rebuild, the vectors no longer describe
	// it — fall back to a runtime embed rather than compare the query against the wrong phrasings.
	if (set.texts.length !== texts.length || set.texts.some((t, i) => t !== texts[i])) {
		return null;
	}
	if (set.vectors.length !== texts.length || set.vectors.some((v) => v.length !== gv.dim)) {
		return null;
	}
	return set.vectors;
}
