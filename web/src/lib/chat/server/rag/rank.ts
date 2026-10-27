// Pure cosine ranking shared by the committed catalog store (localStore) and the
// admin-authored store (adminStore). Kept a LEAF (only ./embed) so the ranking
// invariants are unit-testable in the hermetic CI gate without the model/router graph.
//
// cosine() already returns 0 on a length mismatch, so a wrong-dimension vector scores 0
// and is filtered by minScore — but callers also pass a model-identity guard upstream so a
// same-dim vector from a DIFFERENT embedding model never reaches scoring.

import { cosine } from "./embed";

// toSnippet lives in the pure leaf ./parseDoc (no embed/env graph) so the federated SyftHub path can
// share the SAME trimmer without dragging the model graph in; re-exported here for the cosine-store
// call sites (localStore, adminStore) that already import it from ./rank.
export { toSnippet, stripRecallTail, CURATED_SNIPPET_CAP } from "./parseDoc";

export type Scored<T> = { chunk: T; score: number };

/**
 * Score `chunks` against the query vector by cosine, keep those at/above `minScore`,
 * and return the top `topK` highest-scoring (descending). Deterministic and side-effect free.
 */
export function rankByCosine<T extends { vector: number[] }>(
	queryVector: number[],
	chunks: readonly T[],
	minScore: number,
	topK: number
): Scored<T>[] {
	return chunks
		.map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
		.filter((s) => s.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, topK));
}
