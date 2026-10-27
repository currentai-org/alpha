// The cases that carry this module are two turns logged as `outcome: complete`. The field exists so
// they are distinguishable from a good answer, and from each other.
import { describe, expect, it } from "vitest";
import { answerLengths } from "./answerLength";

// The grounded-hedge replacement the guard substituted when no substance survived. Length is
// what matters, not the wording; 256 characters stands in for a typical replacement.
const GUARD_REPLACEMENT = "x".repeat(256);

describe("answerLengths", () => {
	it("reports the surviving zero, not the guard's replacement, when nothing survived", () => {
		// beforeChars 0 -> afterChars 256. Logging only the shipped length would report 256 here and
		// hide the emptiest turn there is.
		expect(answerLengths(GUARD_REPLACEMENT, 0)).toEqual({ answerChars: 256, modelChars: 0 });
	});

	it("reports two characters for the two-character answer that cleared every guard", () => {
		// The entire answer is `AI`. No guard fired, so no pre-guard length exists and the shipped
		// length IS the model's.
		expect(answerLengths("AI", null)).toEqual({ answerChars: 2, modelChars: 2 });
	});

	it("keeps the two equal on an ordinary unmutated turn", () => {
		const answer = "AI Potluck is the open, map-grounded chat from Current AI.";
		expect(answerLengths(answer, null)).toEqual({
			answerChars: answer.length,
			modelChars: answer.length,
		});
		expect(answerLengths(answer, undefined)).toEqual({
			answerChars: answer.length,
			modelChars: answer.length,
		});
	});

	it("keeps a guard that TRIMMED rather than replaced, so the model still gets credit for what it wrote", () => {
		// A trailing-source-list strip: the model wrote 1200, we shipped 900. modelChars must not
		// silently become 900, or every trimmed turn under-reports what the model produced.
		expect(answerLengths("y".repeat(900), 1200)).toEqual({ answerChars: 900, modelChars: 1200 });
	});

	it("treats a missing message body as zero rather than throwing at the log site", () => {
		expect(answerLengths(null, null)).toEqual({ answerChars: 0, modelChars: 0 });
		expect(answerLengths(undefined, null)).toEqual({ answerChars: 0, modelChars: 0 });
		expect(answerLengths("", 0)).toEqual({ answerChars: 0, modelChars: 0 });
	});

	it("counts characters, not trimmed words — a whitespace-only answer is not zero", () => {
		// Deliberate: an answer of three spaces is a different failure from an answer of nothing, and
		// collapsing them would lose which one happened. The distinction is the guard's job, not this
		// module's, and this module must not pre-empt it.
		expect(answerLengths("   ", null)).toEqual({ answerChars: 3, modelChars: 3 });
	});
});
