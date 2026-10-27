/**
 * The terminal-outcome ladder — how a finished chat turn is classified, and which of those
 * classifications the sustained-failure alert counts.
 *
 * Ordered, and the order is the design. A turn can satisfy several of these at once (a turn that
 * declined and then timed out satisfies both), so the ladder is a precedence chain read top to
 * bottom, and each rung's position is an argument rather than an accident:
 *
 *   aborted    the user navigated away — their act, not ours, and it outranks whatever we were doing
 *   shed       never admitted; the turn does not exist to be judged on anything below
 *   timedOut   the watchdog killed it
 *   error      it broke
 *   declined   a policy refusal that SUCCEEDED at what it set out to do. Below the four failures
 *              because a turn that declined and then broke should report the break, which is the
 *              more actionable signal. Above `complete` because a refused user did not get an
 *              answer, and calling that complete hides a run of refusals (CUR-35).
 *   empty      the pipeline worked and the user got no answer out of it. Below `declined` on that
 *              same reading — a decline is an intended outcome, an empty answer is not one at all.
 *   complete
 *
 * WHY `empty` EXISTS (CUR-445). On a grounded turn where no substance survives, the honesty guard
 * throws the answer away and substitutes a sources pointer — a few hundred characters of OUR copy,
 * which is right for the user (CUR-113: a truthful pointer beats a blank bubble) and wrong for
 * every reader downstream. The route's own empty-output check compares the finished message
 * against what it started as, so the substitution makes it unreachable, and without this rung the
 * turn reports `complete` (for example `beforeChars: 0, afterChars: 256`, then `outcome: complete,
 * firstTokenReached: true`), logged as a healthy answer.
 *
 * WHAT `empty` DOES NOT MEAN, because the obvious reading is wrong. It is
 * NOT "the model emitted zero tokens" — a generation that returns an empty string never yields a
 * FinalAnswer at all (generate.ts gates on `if (output.generated_text)`, and "" is falsy), so it
 * never reaches the guard, the content really is unchanged, and it ALREADY reports `error`. That
 * path is untouched here and should stay untouched: the user saw nothing, and an error status is
 * what tells them so. `empty` is the case where the model emitted SOMETHING and none of it was an
 * answer — pure recency hedge that the per-chunk guards stripped to nothing, or the bare `[1] [2]`
 * shape. Both leave the user reading our copy with no way to tell.
 *
 * `hasError` could not carry it. It is not only a telemetry flag: it emits a user-visible "No
 * output was generated. Something went wrong." status and suppresses the turn's timings stamp.
 * Putting an error banner over a message that says something reasonable is a regression. So this
 * needed its own rung — the turn is not an error, it is not complete either, and only the alert
 * should decide what to do about it.
 */

export type TurnOutcome =
	| "aborted"
	| "shed"
	| "timedOut"
	| "error"
	| "declined"
	| "empty"
	| "complete";

export interface TurnOutcomeInputs {
	/** The user stopped the turn (or navigated away and the stop landed on this pod). */
	abortedByUser: boolean;
	/** The admission gate let this turn in. False ⇒ shed. */
	admitted: boolean;
	/** The generation watchdog fired. */
	timedOut: boolean;
	/**
	 * The output-screen PHASE deadline fired (screenStream.ts's PHASE_DEADLINE_MS, CUR-1657) — a
	 * narrower, separate watchdog from `timedOut` above, but the same rung: the phase never finished
	 * verifying, so nothing here should read as `complete`. Read off `message.outputModeration?.screened
	 * === false`, the one marker screenStream.ts sets only on this trip (CUR-1727). A zero-token phase
	 * timeout writes its own decline text into the message, which would give
	 * `modelChars > 0` and fall through this ladder to `complete` — the app's own canned copy counted as
	 * a successful answer.
	 */
	outputScreenTimedOut: boolean;
	/** The turn threw, or ended with content the route judged unusable. */
	hasError: boolean;
	/** Non-null on a policy refusal; carries which policy refused. */
	declineKind: string | null | undefined;
	/**
	 * A final-only guard threw the WHOLE answer away and substituted our own copy —
	 * `groundedHedgeReplacement`, the route's `guardReplacedAnswer`. This is what actually carries
	 * the `empty` rung: the guard only fires when no substance survived, which is the condition,
	 * stated once by the code that decided it rather than re-derived from a length here.
	 */
	answerSubstituted: boolean;
	/**
	 * Characters that survived to the final-guard stage — `modelChars` from answerLength.ts, never
	 * the finished message's own length, which on a substituted turn is our copy.
	 *
	 * A SECOND arm rather than the only one, because it is a weaker test than it looks: the live
	 * `[1] [2]` answer has seven of these and not one of them is an answer. It stays because a
	 * future guard that empties a turn without being the grounded-hedge replacement would otherwise
	 * pass straight through to `complete`.
	 */
	modelChars: number;
}

/** Classify a finished turn. See the module header for why the order is what it is. */
export function classifyTurnOutcome(t: TurnOutcomeInputs): TurnOutcome {
	if (t.abortedByUser) return "aborted";
	if (!t.admitted) return "shed";
	if (t.timedOut || t.outputScreenTimedOut) return "timedOut";
	if (t.hasError) return "error";
	if (t.declineKind) return "declined";
	if (t.answerSubstituted || t.modelChars === 0) return "empty";
	return "complete";
}

/**
 * What the sustained-failure alert counts as a failure (CUR-89, consumed by warm.ts).
 *
 * Lives HERE, beside the ladder that produces the values, because the two are one taxonomy and
 * were two hand-maintained lists in two files — the shape that drops a new value from one of them
 * silently. Adding a rung above without adding it here is now a decision made in one place.
 *
 * Narrow on purpose. EXCLUDED, each for a reason: `aborted` is a user leaving (expected traffic,
 * would drown the signal); `declined` is policy working as intended, and its failure case
 * (child_safety) has its own probe; `shed` is a capacity signal, not a failure.
 *
 * `empty` is IN, and it is safe there: production over a 14-day window ran 748 turns and never once
 * stripped an answer to nothing (the smallest pre-guard text was 1,046 characters), while preview ran 363
 * turns with five — 1.4%, against a 20% ceiling. So it does not page on normal traffic, and it has real
 * instances to count.
 */
export const FAILURE_OUTCOMES: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>([
	"error",
	"timedOut",
	"empty",
]);
