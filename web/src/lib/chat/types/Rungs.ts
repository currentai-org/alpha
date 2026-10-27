/**
 * What each forced-tool-call pre-pass decided on one turn, persisted on the assistant
 * message beside `timings`. `timings` says how long a stage took; this says what it decided and how it
 * ended, so "why did this turn get no verified number" is a read of the row rather than a log search.
 *
 * Codes and counts only, never user text: this rides on every persisted message. (CUR-2043)
 */

/** Stage 1's answer. `failed` is an error or timeout inside the classifier call; `skipped` is a
 *  deadline that had already passed before the call was made. Both used to read as `no`. */
type GateVerdict = "yes" | "no" | "failed" | "skipped";


/** One pre-pass's record. `outcome` is set only when the pass got past its gate, or was stopped
 *  before it (e.g. `no-user-text`); it names the exit the pass took, one code per exit. */
export interface RungStep {
	/** `math-route` (CUR-2198): `gate` is the turn planner's math verdict (`yes` asked, `no` not asked,
	 *  `failed` no answer), `gateMs` 0; `outcome` is the math field's outcome (ok, not-asked, invalid,
	 *  missing) or, when the call gave no plan, the call's exit (no-call, unparsable, failed, timeout).
	 *  `toolMs` is the call's time. */
	rung: "arithmetic" | "math-route";
	gate?: GateVerdict;
	outcome?: string;
	gateMs: number;
	/** Gate calls made, 1 or 2. Absent when the gate was skipped. (CUR-2057) */
	gateAttempts?: number;
	toolMs?: number;
	/** How many numbers the latest user message holds — the one input feature a later gate could use. */
	numberCount: number;
}

/** Counts digit runs ("1 332" is two, "3.5" is one) in text. A feature for the record, never parsed back. */
export function countNumbers(text: string): number {
	return text.match(/\d+(?:[.,]\d+)*/g)?.length ?? 0;
}
