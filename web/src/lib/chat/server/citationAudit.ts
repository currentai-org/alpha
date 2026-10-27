// Did a grounded turn actually cite the sources it was given? (CUR-151)
//
// THE CONTRACT: `searchGrounding.ts:34` and `ragGrounding.ts:29` both instruct the model to cite
// every factual claim inline with `[n]`, and the second one says "Keep citing even though the answer
// is short." Whether a model follows that differs by checkpoint, and without this audit that is not
// visible anywhere.
//
// This does NOT block or rewrite anything. An uncited grounded answer is still an answer, often a
// correct one, and suppressing it would trade a real defect for a worse one. The point is that
// "grounded answers are cited" becomes a query someone can run instead of a belief — the fail-open
// shape CUR-68 names, where a degradation returns 200 and nothing counts it.
//
// Which means the tally itself has to be able to report the bad case. If every `[n]` counted, `[7]`
// against three sources would score as a citation and the turn would come out `uncited: false`. An
// answer citing a source it was never given is the WORST outcome this audit can see, so it must not
// be recorded as the healthiest; see `danglingCount`.

/** A citable stamp as persisted on the message — only the length matters here. */
type Stamped = { sources?: unknown[] } | undefined | null;

export type CitationAudit = {
	/** The turn was given numbered sources to cite from (RAG, open web, or both). */
	grounded: boolean;
	/** How many numbered sources reached the prompt. */
	sourceCount: number;
	/**
	 * Inline `[n]` markers in the answer body that point at a source the turn was actually given.
	 * Repeats count — `[1] ... [1]` is 2. A marker OUT OF RANGE is not one of these; see `danglingCount`.
	 */
	citationCount: number;
	/** How many DISTINCT source numbers were cited; the useful figure when one source carries an answer. */
	distinctCited: number;
	/**
	 * `[n]` markers naming a source that does not exist — `[7]` against three sources, or `[0]`.
	 *
	 * Counted apart from `citationCount` rather than folded into it, because the two are opposite
	 * findings that a single tally would cancel. Scoring them as citations would make the metric read
	 * healthiest on the worst case it has: an answer that cites nothing it was given and invents a
	 * number instead would score `uncited: false`, i.e. compliant. Same direction as the `replacedByGuard`
	 * exclusion below — do not let our own or the model's fabricated markers stand in for compliance.
	 */
	danglingCount: number;
	/**
	 * The alertable condition: sources were supplied and the answer cites none of them. Deliberately
	 * NOT set for a guard-replaced answer — see `replacedByGuard`.
	 */
	uncited: boolean;
};

const MARKER = /\[(\d+)\]/g;

/**
 * Audit one finished turn.
 *
 * `replacedByGuard` matters and is not optional-by-accident: when a grounded turn's whole answer
 * bails, `buildGroundedHedgeReplacement` substitutes text that WE wrote, and that text lists the
 * sources as `[1] Title, [2] Title`. Counting those as citations would score our own fallback copy
 * as model compliance and make the metric read healthiest exactly when the model answered worst.
 * Such a turn reports `uncited: false` because the question does not apply to it, not because it
 * passed.
 */
export function auditCitations(opts: {
	text: string;
	rag?: Stamped;
	webSearch?: Stamped;
	replacedByGuard?: boolean;
}): CitationAudit {
	const { text, rag, webSearch, replacedByGuard = false } = opts;

	const sourceCount = (rag?.sources?.length ?? 0) + (webSearch?.sources?.length ?? 0);
	const grounded = sourceCount > 0;

	// A marker only counts against the sources this turn was HANDED. `[7]` with three sources cites
	// nothing — the numbering is 1-based and assigned by the grounding prompt, so anything outside
	// 1..sourceCount names a source that was never in the context.
	const seen = new Set<string>();
	let citationCount = 0;
	let danglingCount = 0;
	for (const m of text.matchAll(MARKER)) {
		const n = Number(m[1]);
		if (n >= 1 && n <= sourceCount) {
			citationCount++;
			seen.add(m[1]);
		} else {
			danglingCount++;
		}
	}

	return {
		grounded,
		sourceCount,
		citationCount,
		distinctCited: seen.size,
		danglingCount,
		uncited: grounded && citationCount === 0 && !replacedByGuard,
	};
}
