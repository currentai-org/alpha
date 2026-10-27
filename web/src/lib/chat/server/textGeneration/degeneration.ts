// Detect a generation that stopped saying anything and kept emitting (CUR-149).
//
// A collapsed generation looks like this tail of a two-train arithmetic answer, which streamed on
// and ended mid-token on `\( m`:
//
//   = **\mathbf{+}\,{\color{gray} { }}\) **\mathbf{+}\,\boxed{\mathbf{ }}\) wait compute numeric
//
// and the turn logged `outcome: complete` with `interrupted` unset. Nothing in telemetry tells it
// apart from a good answer, which is the actual defect — the wreck reaching the user is bad, the
// wreck being INVISIBLE is what makes it unfixable.
//
// ── WHY NOT A SYMBOL RATIO OR A REPETITION RATIO ─────────────────────────────────────────────────
//
// A bounded ratio of non-alphanumeric output and a repeated-fragment ratio both fail, measured
// against that tail and against legitimate answers this product gives, and they fail in the
// direction that matters — the good answer scores WORSE than the wreck:
//
//   metric                     wreck    dense LaTeX   md table   repetitive code   plain prose
//   non-alphanumeric ratio     0.409      0.412         0.326         —              ~0.10
//   repeated-shingle ratio     0.016      0.038         0.034        0.079            0.000
//   EMPTY MARKUP GROUPS          4          0             0            0               0
//
// A threshold on either of the first two cannot be set: there is no value that fires on the wreck
// and spares a quadratic-formula derivation. Either would be a check that reports a number and
// cannot go red for the failure it names.
//
// ── WHAT ACTUALLY SEPARATES THEM ─────────────────────────────────────────────────────────────────
//
// A markup group with nothing inside it. `\boxed{\mathbf{ }}`, `{\color{gray} { }}` — structure
// emitted with no content to structure. This is mechanism, not a fitted threshold: a group whose
// body has no letter or digit is meaningless by construction, so a model producing them has lost
// the thread regardless of how symbol-dense the surrounding text is. Every legitimate fixture
// scores exactly zero, because a real derivation always has something inside its braces.
//
// ── WHAT THIS DOES NOT CATCH, STATED PLAINLY ─────────────────────────────────────────────────────
//
// Structural collapse in markup, and only that. A degeneration that loops in plain prose ("Wait —
// recalc. Better way: Wait — recalc.") trips nothing here, and the repeated-shingle numbers above
// say a naive repetition metric will not catch it either. Validated against one recorded case,
// which is enough to justify the signal's mechanism and not enough to justify a tuned threshold —
// so the threshold is 1, the smallest number that means "this happened at all".
//
// This module OBSERVES. It does not mutate the answer. Whether a tripped probe should replace the
// text with an honest "I couldn't work this through" is a product decision with a real cost when it
// misfires, and it is not made here.

/** Fenced blocks are excised before measuring: a shell heredoc or a brace-heavy snippet is content,
 *  not collapse, and judging code as prose is the fastest way to a false positive. Exported —
 *  repetitionGuard.ts (CUR-1104) excises the same two spans for the same reason before its own
 *  n-gram measurement, rather than re-deriving a second copy of "what counts as prose here". */
export const FENCE_RE = /(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*?(?:\n[ \t]*(?:```|~~~)|$)/g;

/** Inline code spans, excised for the same reason: a paragraph containing `` `{}` `` is a correct
 *  thing to write about TypeScript and is indistinguishable from collapse once the backticks are
 *  ignored. */
export const INLINE_CODE_RE = /`[^`\n]*`/g;

/** Innermost `{...}` groups. Non-nested by construction so `{\mathbf{ }}` yields its inner `{ }`. */
const GROUP_RE = /\{[^{}]*\}/g;

/**
 * Letters and digits across scripts. `\p{L}`/`\p{N}` rather than `[A-Za-z0-9]` so a Cyrillic or CJK
 * answer is not scored as symbol soup — that mistake would turn this into a language filter, which
 * is a worse bug than the one it is fixing.
 */
const ALNUM_RE = /[\p{L}\p{N}]/u;

/** One is enough. A legitimate answer emits zero, so anything above zero is the event itself. */
export const DEGENERATION_MAX_EMPTY_GROUPS = 0;

export interface DegenerationVerdict {
	/** markup groups whose body carries no letter or digit — the discriminating signal */
	emptyGroups: number;
	/** non-alphanumeric fraction of the measured text; RECORDED, never thresholded (see the header) */
	symbolRatio: number;
	/** measurable characters after fences were excised and whitespace collapsed */
	chars: number;
	/** emptyGroups exceeded the bound */
	degenerate: boolean;
}

/**
 * Score an answer for structural collapse. Pure and allocation-cheap — this runs once per turn on
 * the FinalAnswer path, so it must never be the reason a turn is slow.
 *
 * `symbolRatio` is returned so the distribution becomes queryable in production rather than argued
 * about from two fixtures. If it ever turns out to separate on real traffic, the threshold can be
 * set from that data instead of from this file.
 */
export function measureDegeneration(text: string): DegenerationVerdict {
	const prose = (text ?? "").replace(FENCE_RE, " ").replace(INLINE_CODE_RE, " ");
	const measurable = prose.replace(/\s+/g, "");
	const chars = measurable.length;

	let alnum = 0;
	for (const ch of measurable) if (ALNUM_RE.test(ch)) alnum++;
	const symbolRatio = chars ? (chars - alnum) / chars : 0;

	let emptyGroups = 0;
	for (const g of prose.match(GROUP_RE) ?? []) {
		if (!ALNUM_RE.test(g)) emptyGroups++;
	}

	return {
		emptyGroups,
		symbolRatio,
		chars,
		degenerate: emptyGroups > DEGENERATION_MAX_EMPTY_GROUPS,
	};
}
