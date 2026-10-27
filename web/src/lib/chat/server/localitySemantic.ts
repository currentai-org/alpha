// Semantic locality-dependence detector — the embedding catch-all that backs the regex localityGuard
// (cf. semanticHedge.ts, which plays this same role for hedgeGuard.ts).
//
// The regex misses real locality-dependent questions phrased without
// its trigger words — "should I plead guilty" (no "legal"/"court"/"jurisdiction" in the text, yet the
// answer depends on the user's country) and "is nuclear energy a good idea" (no locality keyword, yet
// retrieval can return a country-specific source for a country-agnostic question). The locality note
// pre-empts an overclaim like "for X specifically, per your question" without a keyword list trying to
// enumerate every locality-dependent phrasing.
//
// HYBRID, same shape as semanticHedge: the cheap regex pass first (isLocalityQuery), embeddings only
// when it didn't already fire. Fails OPEN to the regex-only result on any embedding failure (or when
// disabled) — never blocks a turn, at worst degrades to today's behavior.
//
// UNVALIDATED THRESHOLD — unlike semanticHedge (validated against a real embedding
// endpoint), this module's threshold has not been calibrated against live embeddings. It defaults
// to OFF for that reason — set LOCALITY_SEMANTIC_ENABLED=true only after validating recall (catches phrasings like the two above)
// and precision (does NOT fire on context-free general-knowledge questions — the "no blanket
// caveating" requirement the regex already enforces) against the real endpoint, the same pass
// semanticHedge got before it shipped enabled-by-default.

import { config } from "$lib/chat/server/config";
import { embedTexts, cosine } from "$lib/chat/server/rag/embed";
import { precomputedGuardVecs } from "./guardVectors";
import { isLocalityQuery } from "./localityGuard";
import localityExamplesRaw from "./data/localityExamples.json";

// Locality-dependent questions that carry NONE of LOCALITY_RE's trigger words — exactly the recall gap
// this hybrid exists to close. Broaden by adding a phrasing to data/localityExamples.json — never a
// regex — then `npm run build:guard-vectors` to refresh the committed vectors (they're precomputed at
// build time; see guardVectors.ts). The build's --check drift guard fails CI if the two fall out of sync.
const LOCALITY_EXAMPLES = localityExamplesRaw as string[];

const read = (k: string): string => ((Reflect.get(config, k) as string | undefined) ?? "").trim();

/** Max cosine threshold a candidate must clear to be flagged. UNVALIDATED starting point (mirrors
 *  semanticHedge's validated 0.4) — tune against a real embedding endpoint before trusting it.
 *  Tunable via LOCALITY_SEMANTIC_THRESHOLD. */
export function localitySemanticThreshold(): number {
	const n = Number(read("LOCALITY_SEMANTIC_THRESHOLD"));
	return Number.isFinite(n) && n > 0 ? n : 0.4;
}

/** Kill switch — default OFF (see module doc: threshold isn't live-validated yet). */
export function localitySemanticEnabled(): boolean {
	return read("LOCALITY_SEMANTIC_ENABLED") === "true";
}

// Resolve the example-set vectors ONCE per process and cache. Prefer the build-time precomputed vectors
// (guardVectors.ts) so the runtime guard path does at most one embed (the query itself); fall back to a
// runtime batched embed only when the committed artifact can't be trusted (model swap / edited-without-
// rebuild). Retried on failure (not cached).
let exampleVecs: number[][] | null = null;
async function localityExampleVecs(): Promise<number[][] | null> {
	if (exampleVecs) return exampleVecs;
	const pre = precomputedGuardVecs("locality", LOCALITY_EXAMPLES);
	if (pre) {
		exampleVecs = pre;
		return pre;
	}
	const v = await embedTexts(LOCALITY_EXAMPLES);
	if (v) exampleVecs = v;
	return v;
}

/** Hybrid regex / embedding locality-dependence check for a user turn. True when the regex fires OR
 *  the turn's embedding clears the semantic threshold against LOCALITY_EXAMPLES. Fails open to the
 *  regex-only result (today's behavior) on any embedding failure or when disabled. */
export async function isLocalityQuerySemantic(text: string): Promise<boolean> {
	const t = text ?? "";
	if (isLocalityQuery(t)) return true;
	if (!t.trim() || !localitySemanticEnabled()) return false;

	const exVecs = await localityExampleVecs();
	if (!exVecs) return false; // fail open — embedding pass unavailable
	const [vec] = (await embedTexts([t])) ?? [];
	if (!vec) return false;
	// exVecs may be BUILD-TIME precomputed (guardVectors). If the ACTIVE embedding endpoint's output
	// dimension differs from the committed artifact's (e.g. RAG_EMBEDDING_ENDPOINT_URL points at a
	// different-dim model than RAG_EMBEDDING_MODEL labels), the two are from different vector spaces —
	// re-embed the examples through the live endpoint so cosine compares within ONE space. Fail open if
	// even the live embed can't match. (guardVectors's model-identity guard mirrors localStore/rag-index;
	// this runtime dimension cross-check is the belt to that suspenders.)
	const ex = vec.length === exVecs[0]?.length ? exVecs : await embedTexts(LOCALITY_EXAMPLES);
	if (!ex || vec.length !== ex[0]?.length) return false;

	const maxC = Math.max(...ex.map((e) => cosine(vec, e)));
	return maxC >= localitySemanticThreshold();
}

/** Test-only: clear the cached example vectors so a spec can re-mock the embedding seam. */
export function _resetLocalityCache(): void {
	exampleVecs = null;
}
