// How much text a turn actually produced (CUR-443).
//
// WHY THIS EXISTS. Without a length, `[turn] outcome` records the outcome, four timings, the model and
// four citation counts, and a turn whose entire answer is the two characters `AI` logs `outcome:
// complete, firstTokenReached: true`, in telemetry exactly a good answer. The honesty guard does not
// fire (its gate needs ZERO alphanumerics and `AI` has two) and degeneration.ts does not fire (it
// detects empty markup groups, and there is no markup). A broken answer reaching the user is bad; a
// broken answer that is invisible in telemetry is unfixable.
//
// WHY TWO NUMBERS AND NOT ONE. The obvious implementation — log the finished message's length — is
// blind to the worse case. When no substance survives, the grounded-hedge guard replaces the answer
// with a sources pointer, so the shipped message is a few hundred characters of OUR copy. Logging
// only that reports a healthy length for the turn that produced no answer at all. `modelChars` is
// measured BEFORE any final-only guard rewrote the text; `answerChars` is what the user received.
// They differ only on a mutated turn (rare), and on exactly those turns the
// difference is the whole story.
//
// READ `modelChars` FOR WHAT IT IS: characters that survived to the final-guard stage, which is not
// the same as characters the model emitted. The per-chunk guards run first and can strip a whole
// answer to nothing, so `modelChars: 0` covers both "wrote nothing" and "wrote only recency hedge".
// It is also not the test for whether a turn produced an answer — a turn whose answer is just `[1] [2]` has
// seven of these. `guardReplacedAnswer` is that test; see outcomeLadder.ts, which uses this only as a
// second arm (CUR-445).
//
// NO THRESHOLD HERE, deliberately. One recorded case is enough to justify measuring and nowhere
// near enough to justify a floor: a bound fitted to n=1 reports a number and cannot go red for the
// failure it names. Read the logged distribution before deciding whether a floor exists and where.

export interface AnswerLengths {
	/** Characters the user received, after any final-only guard. */
	answerChars: number;
	/**
	 * Characters that survived to the final-guard stage — see the header for why that is not the
	 * same as characters the model emitted. Equal to `answerChars` on the ordinary turn where no
	 * guard fired; the two diverge only when one did, and that divergence is the signal.
	 */
	modelChars: number;
}

/**
 * @param content        the finished message text, as persisted and shown
 * @param preGuardChars  `beforeChars` off the first final-only mutation, or null when none ran.
 *                       Null means nothing rewrote the answer, so the shipped length IS the model's.
 */
export function answerLengths(
	content: string | null | undefined,
	preGuardChars: number | null | undefined
): AnswerLengths {
	const answerChars = (content ?? "").length;
	// `?? answerChars` and not `|| answerChars`: zero is the single most interesting value this
	// argument takes — nothing survived to be shown — and `||` would discard it for the guard's
	// replacement length, reporting the empty turn as healthy. That is the bug this module is for,
	// reproduced inside its own fix if written the obvious way.
	return { answerChars, modelChars: preGuardChars ?? answerChars };
}
