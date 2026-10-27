import { describe, it, expect } from "vitest";
import assert from "node:assert";
import {
	detectContentFreeChallenge,
	buildRecomputeMessages,
	REDERIVE_INSTRUCTION,
} from "./challengeGuard";

const PRIOR = "The answer is D — Nauru.";

describe("detectContentFreeChallenge", () => {
	it("fires on bare content-free pushback after a prior answer", () => {
		for (const u of [
			"I don't think that's right. Are you sure?",
			"Are you sure?",
			"that's wrong",
			"you're wrong",
			"Really?",
			"hmm, can you double-check?",
			"I disagree.",
		]) {
			expect(detectContentFreeChallenge({ priorAssistant: PRIOR, userText: u })).toBe(true);
		}
	});

	it("does NOT fire when the user supplies a real correction (new info → honor it)", () => {
		for (const u of [
			"No, it's B because Vatican City is under a square mile.",
			"That's wrong, the answer is actually A.",
			"I think it should be 1492, not 1493.",
			"No, the correct answer is Monaco.",
		]) {
			expect(detectContentFreeChallenge({ priorAssistant: PRIOR, userText: u })).toBe(false);
		}
	});

	it("does NOT fire without a prior assistant turn (nothing to challenge)", () => {
		expect(detectContentFreeChallenge({ priorAssistant: "", userText: "are you sure?" })).toBe(
			false
		);
		expect(detectContentFreeChallenge({ userText: "are you sure?" })).toBe(false);
	});

	it("does NOT fire on ordinary follow-up questions", () => {
		for (const u of [
			"Can you explain why?",
			"What's the population of Nauru?",
			"Thanks, and what about the largest?",
		]) {
			expect(detectContentFreeChallenge({ priorAssistant: PRIOR, userText: u })).toBe(false);
		}
	});

	it("does NOT fire on a long argued pushback (that's a substantive disagreement)", () => {
		const longArgued =
			"are you sure about that, because I read somewhere that the metric actually counts inland water area separately and that would change which country qualifies here";
		expect(detectContentFreeChallenge({ priorAssistant: PRIOR, userText: longArgued })).toBe(false);
	});

	it("handles empty/undefined safely", () => {
		expect(detectContentFreeChallenge({})).toBe(false);
		expect(detectContentFreeChallenge({ priorAssistant: PRIOR, userText: "" })).toBe(false);
	});
});

describe("buildRecomputeMessages", () => {
	const Q = { from: "user", content: "Which is larger, 0.9 or 0.11?", id: "q1" };
	const A = { from: "assistant", content: "0.11 is larger.", id: "a1" };
	const CH = { from: "user", content: "Are you sure?", id: "c1" };

	it("drops the prior answer + the challenge and re-derives the original question", () => {
		const out = buildRecomputeMessages([Q, A, CH]);
		expect(out).not.toBeNull();
		assert(out); // narrow Message[] | null → Message[] for the accesses below
		expect(out).toHaveLength(1);
		const only = out[0];
		expect(only.from).toBe("user");
		expect(only.content.startsWith(Q.content)).toBe(true); // original question preserved
		expect(only.content.endsWith(REDERIVE_INSTRUCTION)).toBe(true); // instruction appended last
		expect(only.content).not.toContain("Are you sure?"); // pushback removed from context
		expect(only.content).not.toContain("0.11 is larger"); // anchoring prior answer removed
		expect(only.id).toBe("q1"); // non-content fields preserved (preprocessMessages needs them)
	});

	it("preserves earlier history before the challenged pair", () => {
		const pre = { from: "user", content: "hi", id: "p0" };
		const preA = { from: "assistant", content: "hello", id: "p1" };
		const out = buildRecomputeMessages([pre, preA, Q, A, CH]);
		assert(out); // narrow Message[] | null → Message[] for the accesses below
		expect(out).toHaveLength(3);
		expect(out[0]).toEqual(pre);
		expect(out[1]).toEqual(preA);
		expect(out[2].content.startsWith(Q.content)).toBe(true);
	});

	it("returns null when the [question, answer, challenge] shape isn't present", () => {
		expect(buildRecomputeMessages([Q, CH])).toBeNull(); // too short
		expect(buildRecomputeMessages([Q, A, A])).toBeNull(); // last turn not a user challenge
		expect(buildRecomputeMessages([A, A, CH])).toBeNull(); // no user question before the answer
	});
});
