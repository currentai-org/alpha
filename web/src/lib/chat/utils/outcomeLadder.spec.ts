// The ladder's ORDER is the thing under test, not its branches. Every case below is a turn that
// satisfies two rungs at once and must report the higher one — which is the only property a
// precedence chain has, and the only one a per-branch test cannot see.
//
// The `empty` cases are anchored on a real turn shape: `beforeChars: 0 → afterChars: 256`, which
// would otherwise report `outcome: complete`.
import { describe, expect, it } from "vitest";
import { classifyTurnOutcome, FAILURE_OUTCOMES, type TurnOutcomeInputs } from "./outcomeLadder";

/** A turn that went well: nothing tripped, the model wrote an answer. Rungs are flipped per-case. */
const healthy: TurnOutcomeInputs = {
	abortedByUser: false,
	admitted: true,
	timedOut: false,
	outputScreenTimedOut: false,
	hasError: false,
	declineKind: null,
	answerSubstituted: false,
	modelChars: 412,
};

const turn = (over: Partial<TurnOutcomeInputs>) => classifyTurnOutcome({ ...healthy, ...over });

describe("classifyTurnOutcome", () => {
	it("reports complete for an ordinary answered turn", () => {
		expect(turn({})).toBe("complete");
	});

	describe("the empty rung (CUR-445)", () => {
		it("reports empty, not complete, when a guard shipped 256 characters the model did not write", () => {
			// The defect exactly: content changed, so the route's own empty-output check never fired,
			// and every downstream reader saw a healthy turn.
			expect(turn({ answerSubstituted: true, modelChars: 0 })).toBe("empty");
		});

		// THE case that made `answerSubstituted` the primary test and demoted modelChars to a second arm: an
		// answer that is the seven characters `[1] [2]` — a positive length, and not one character of an answer. A
		// ladder keyed on `modelChars === 0` calls this complete.
		it("reports empty for a `[1] [2]` answer, whose SEVEN characters are all citation markers", () => {
			expect(turn({ answerSubstituted: true, modelChars: 7 })).toBe("empty");
		});

		it("keeps the length arm for a guard that empties a turn without being the hedge replacement", () => {
			expect(turn({ answerSubstituted: false, modelChars: 0 })).toBe("empty");
		});

		it("does not treat SHORT as empty — a two-character answer is complete", () => {
			// CUR-443 measures brevity and deliberately sets no floor. A ladder that treated "short"
			// as "empty" would smuggle one in here, fitted to n=1.
			expect(turn({ modelChars: 2 })).toBe("complete");
		});

		it("still reports error for a turn nothing substituted for — the user saw nothing, and that is an error", () => {
			// No FinalAnswer ever reached the guard, so the route's string comparison found the content
			// unchanged and set hasError. That path is untouched by CUR-445 and must stay untouched.
			expect(turn({ modelChars: 0, hasError: true })).toBe("error");
		});
	});

	describe("the outputScreenTimedOut rung (CUR-1727)", () => {
		it("reports timedOut, not complete, for a phase-deadline trip whose own decline text is the only content", () => {
			// The defect exactly: on a phase-deadline trip with nothing screened, screenStream.ts writes its
			// own canned decline string into the message, and that string's own length gives modelChars a
			// positive count. Without outputScreenTimedOut this fell through to complete.
			expect(turn({ outputScreenTimedOut: true, modelChars: 74 })).toBe("timedOut");
		});

		it("still beats error, declined and empty, same as the generation watchdog's timedOut", () => {
			expect(turn({ outputScreenTimedOut: true, hasError: true })).toBe("timedOut");
			expect(turn({ outputScreenTimedOut: true, declineKind: "content_policy" })).toBe("timedOut");
			expect(turn({ outputScreenTimedOut: true, answerSubstituted: true, modelChars: 0 })).toBe(
				"timedOut"
			);
		});

		it("loses to aborted and shed, same as timedOut", () => {
			expect(turn({ outputScreenTimedOut: true, abortedByUser: true })).toBe("aborted");
			expect(turn({ outputScreenTimedOut: true, admitted: false })).toBe("shed");
		});
	});

	describe("precedence — a turn on two rungs reports the higher one", () => {
		it("aborted beats every rung below it, including empty", () => {
			expect(turn({ abortedByUser: true, answerSubstituted: true })).toBe("aborted");
			expect(turn({ abortedByUser: true, hasError: true, timedOut: true })).toBe("aborted");
		});

		it("shed beats timedOut, error, declined and empty", () => {
			expect(turn({ admitted: false, timedOut: true })).toBe("shed");
			expect(turn({ admitted: false, answerSubstituted: true })).toBe("shed");
		});

		it("timedOut beats error — the watchdog naming the cause is the more actionable signal", () => {
			expect(turn({ timedOut: true, hasError: true })).toBe("timedOut");
		});

		it("error beats declined — a turn that declined and then broke reports the break", () => {
			expect(turn({ hasError: true, declineKind: "child_safety" })).toBe("error");
		});

		it("declined beats empty — a refusal is an intended outcome, an empty answer is not one", () => {
			// A decline substitutes its own copy, so the model may well have written nothing. Reporting
			// that as `empty` would move every policy refusal into the failure set.
			expect(turn({ declineKind: "child_safety", answerSubstituted: true, modelChars: 0 })).toBe(
				"declined"
			);
		});

		it("declined beats complete — a refused user did not get an answer (CUR-35)", () => {
			expect(turn({ declineKind: "content_policy" })).toBe("declined");
		});
	});
});

describe("FAILURE_OUTCOMES", () => {
	it("counts the three ways a turn ends without an answer through no choice of anyone's", () => {
		expect([...FAILURE_OUTCOMES].sort()).toEqual(["empty", "error", "timedOut"]);
	});

	it("does NOT count a user leaving or a policy refusal — both would drown the signal", () => {
		expect(FAILURE_OUTCOMES.has("aborted")).toBe(false);
		expect(FAILURE_OUTCOMES.has("declined")).toBe(false);
		expect(FAILURE_OUTCOMES.has("shed")).toBe(false);
		expect(FAILURE_OUTCOMES.has("complete")).toBe(false);
	});
});
