// Semantic hedge/denial detector — the embedding catch-all that backs the regex hedgeGuard. String
// patterns can't enumerate the infinite ways a model phrases "I can't search the web" (such as
// "I'm a machine AND cannot…", "I'm JUST a language model…", "Being a text-based AI, I lack…");
// a bi-encoder matches MEANING. Validated with all-MiniLM via HF feature-extraction: max
// cosine of a candidate sentence to the example set cleanly separates denials/hedges (0.49–0.69) from
// substance (≤0.21), so a ~0.4 threshold catches every denial and zero substantive sentences.
//
// HYBRID: the regex pass (hedgeGuard.isHedgeSentence) flags the obvious cases cheaply + zero-latency;
// the embedding pass only runs on the sentences regex DIDN'T flag, adding recall. Reuses hedgeGuard's
// sentence splitter + MIN_KEEP_CHARS safe-strip floor so the two layers never diverge. Fails OPEN to the
// regex-only result on any embedding failure (or when disabled), so it never breaks a turn — at worst it
// degrades to today's behavior. Only ever STRIPS a hedge sentence on a GROUNDED turn (caller's gate).

import { config } from "$lib/chat/server/config";
import { embedTexts, cosine } from "$lib/chat/server/rag/embed";
import { precomputedGuardVecs } from "./guardVectors";
import {
	isHedgeSentence,
	isSourceAnswerSentence,
	splitSentences,
	hasSubstantiveText,
	joinKeptSentences,
	MIN_KEEP_CHARS,
	type RecencyHedgeResult,
} from "./hedgeGuard";
import hedgeExamplesRaw from "./data/hedgeExamples.json";

// Examples spanning BOTH failure modes a grounded turn must not produce: web/search-access CAPABILITY
// denials, and recency/knowledge-cutoff HEDGES. Broaden recall by adding a phrasing to
// data/hedgeExamples.json — never a regex — then `npm run build:guard-vectors` to refresh the committed
// vectors (they're precomputed at build time; see guardVectors.ts). The build's --check drift guard
// fails CI if the two fall out of sync.
const HEDGE_EXAMPLES = hedgeExamplesRaw as string[];

const read = (k: string): string => ((Reflect.get(config, k) as string | undefined) ?? "").trim();

/** Max cosine threshold a candidate must clear to be flagged. Validated margin: denials ≥0.49,
 *  substance ≤0.21, so 0.4 sits comfortably in the gap. Tunable via SEMANTIC_HEDGE_THRESHOLD. */
export function semanticHedgeThreshold(): number {
	const n = Number(read("SEMANTIC_HEDGE_THRESHOLD"));
	return Number.isFinite(n) && n > 0 ? n : 0.4;
}

/** Kill switch (default ON): validated, fails open, only strips a hedge sentence on a grounded turn. */
export function semanticHedgeEnabled(): boolean {
	return read("SEMANTIC_HEDGE_ENABLED") !== "false";
}

// Embeddings add recall, but they should only judge sentences that already smell like a capability
// denial or recency-advice hedge. This keeps proper-noun project prose like "Current AI is a live map"
// from being compared against the hedge examples just because it contains words from the recency domain.
const SEMANTIC_HEDGE_CANDIDATE =
	/\b(?:I|me|my|myself|language model|text-based\s+AI|assistant|can't|cannot|can not|unable|lack|without|access|knowledge|training|cutoff|cut-off|browse|consult|refer to|check|visit)\b/i;

// Resolve the example-set vectors ONCE per process and cache. Prefer the build-time precomputed vectors
// (guardVectors.ts) so a grounded turn's post-stream strip does at most one embed round of the actual
// answer sentences; fall back to a runtime batched embed only when the committed artifact can't be
// trusted (model swap / edited-without-rebuild). Retried on failure (not cached).
let exampleVecs: number[][] | null = null;
async function hedgeExampleVecs(): Promise<number[][] | null> {
	if (exampleVecs) return exampleVecs;
	const pre = precomputedGuardVecs("hedge", HEDGE_EXAMPLES);
	if (pre) {
		exampleVecs = pre;
		return pre;
	}
	const v = await embedTexts(HEDGE_EXAMPLES);
	if (v) exampleVecs = v;
	return v;
}

/** Hybrid recency-hedge / capability-denial detector for a GROUNDED answer. A sentence is stripped when
 *  the regex flags it OR its embedding clears the semantic threshold. Same conservative safe-strip
 *  (MIN_KEEP_CHARS) as the regex guard — never returns an empty/gutted answer. Fails open to regex-only. */
export async function detectRecencyHedgeSemantic(text: string): Promise<RecencyHedgeResult> {
	const original = text ?? "";
	if (!original.trim())
		return { hedged: false, cleaned: original, keptText: original, bailedWholeAnswer: false };
	const sentences = splitSentences(original);

	// Cheap regex pass first.
	const flagged = sentences.map(isHedgeSentence);

	// Embedding pass — only over the sentences regex didn't already flag (saves embeddings + latency).
	if (semanticHedgeEnabled()) {
		const pending = sentences
			.map((_, i) => i)
			.filter(
				(i) =>
					!flagged[i] &&
					!isSourceAnswerSentence(sentences[i]) &&
					SEMANTIC_HEDGE_CANDIDATE.test(sentences[i])
			);
		if (pending.length) {
			const exVecs = await hedgeExampleVecs();
			const vecs = exVecs ? await embedTexts(pending.map((i) => sentences[i])) : null;
			if (exVecs && vecs) {
				// exVecs may be BUILD-TIME precomputed (guardVectors). Reconcile against the ACTIVE endpoint's
				// output dimension before comparing across vector spaces: if the dims differ (a config where the
				// embedding endpoint serves a different-dim model than the artifact), re-embed the examples live.
				// See localitySemantic for the full rationale. Skip the pass (regex-only) if it still can't match.
				const ex = vecs[0]?.length === exVecs[0]?.length ? exVecs : await embedTexts(HEDGE_EXAMPLES);
				if (ex && ex[0]?.length === vecs[0]?.length) {
					const thr = semanticHedgeThreshold();
					pending.forEach((sIdx, k) => {
						const maxC = Math.max(...ex.map((e) => cosine(vecs[k], e)));
						if (maxC >= thr) flagged[sIdx] = true;
					});
				}
			}
		}
	}

	const kept = sentences.filter((_, i) => !flagged[i]);
	if (kept.length === sentences.length)
		return { hedged: false, cleaned: original, keptText: original, bailedWholeAnswer: false };
	const keptText = joinKeptSentences(kept);
	// Identical rule to the regex guard: `bailedWholeAnswer` is "no substantive content survives the
	// strip" (the whole answer was a hedge), NOT a char-count — a short complete non-hedge sentence is
	// useful residue read via `keptText`. `cleaned` keeps the conservative safe-strip floor. Citation
	// markers stripped first — see hedgeGuard.ts's matching comment: a bare
	// "[1] [2]" kept-text must count as NO substance, not be saved by the digits inside the brackets.
	const bailedWholeAnswer = !hasSubstantiveText(keptText);
	const cleaned = keptText.length >= MIN_KEEP_CHARS ? keptText : original;
	return { hedged: true, cleaned, keptText, bailedWholeAnswer };
}

/** Test-only: clear the cached example vectors so a spec can re-mock the embedding seam. */
export function _resetHedgeCache(): void {
	exampleVecs = null;
}
