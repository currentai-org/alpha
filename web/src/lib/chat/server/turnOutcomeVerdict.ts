/**
 * The turn-outcome rate alert's decision, kept free of the DB and the logger so a replay of real rows
 * and the unit tests run the same code the cron does (CUR-2242).
 *
 * Firing (CUR-89): over a 6h window with at least MIN_SAMPLE turns, more than MAX_FAIL_RATE of them
 * failed. Prod runs 3–5 turns an hour, so a 15-minute burst of timeouts holds that window over 80%
 * failed for hours after answers are completing again, re-posting DOWN on every read until the burst
 * ages out. The 6h window is right for deciding a failure is happening and wrong for deciding it has
 * ended.
 *
 * Recovery reads the newest evidence instead: the newest failure is at least RECOVERY_QUIET_MS old, and
 * at least RECOVERY_MIN_COMPLETE turns completed after it. Both halves are needed. Completions alone
 * would clear on two lucky turns in the middle of flapping failures; quiet alone would clear on no
 * traffic at all, and silence is not evidence of health — the posture every verdict below keeps.
 */

export const TURN_OUTCOME_WINDOW_MS = 6 * 60 * 60_000;
const TURN_OUTCOME_MIN_SAMPLE = 15;
const TURN_OUTCOME_MAX_FAIL_RATE = 0.2;
/** Two, because traffic is sparse: the first hour after a recovery can hold as few as two completed turns. */
const TURN_OUTCOME_RECOVERY_MIN_COMPLETE = 2;
const TURN_OUTCOME_RECOVERY_QUIET_MS = 15 * 60_000;

export type TurnOutcomeEvidence = {
	/** Turns in the window, by outcome. */
	counts: Record<string, number>;
	failureOutcomes: ReadonlySet<string>;
	/** Newest failed turn in the window; null when there is none. */
	newestFailureAt: Date | null;
	/** Completed turns strictly after newestFailureAt. */
	completesSinceFailure: number;
	now: Date;
};

export type TurnOutcomeVerdict =
	/** Too few turns to call either way. Record nothing, so a firing alert stays firing. */
	| { kind: "no-verdict"; total: number; failures: number }
	| { kind: "healthy"; total: number; failures: number; rate: number }
	| { kind: "failing"; total: number; failures: number; rate: number }
	/** Over the ceiling on the 6h window, but the newest evidence says answers are completing again. */
	| { kind: "recovered"; total: number; failures: number; rate: number; completesSinceFailure: number };

export function turnOutcomeVerdict(e: TurnOutcomeEvidence): TurnOutcomeVerdict {
	const total = Object.values(e.counts).reduce((a, b) => a + b, 0);
	const failures = [...e.failureOutcomes].reduce((a, k) => a + (e.counts[k] ?? 0), 0);
	if (total < TURN_OUTCOME_MIN_SAMPLE) return { kind: "no-verdict", total, failures };
	const rate = failures / total;
	if (rate <= TURN_OUTCOME_MAX_FAIL_RATE) return { kind: "healthy", total, failures, rate };
	const quiet =
		e.newestFailureAt !== null &&
		e.now.getTime() - e.newestFailureAt.getTime() >= TURN_OUTCOME_RECOVERY_QUIET_MS;
	if (quiet && e.completesSinceFailure >= TURN_OUTCOME_RECOVERY_MIN_COMPLETE) {
		return { kind: "recovered", total, failures, rate, completesSinceFailure: e.completesSinceFailure };
	}
	return { kind: "failing", total, failures, rate };
}
