import { describe, it, expect } from "vitest";
import { stripThink, droppedUnclosedThink } from "./stripThink";

// Why this distinction earns a function: three different facts (budget spent reasoning, model said
// nothing, call threw) must not collapse into one silent `null`. The first is a structural failure: at
// 1024 tokens a reasoning panelist cannot answer a substantive question, so the panel reads "empty"
// for every question worth asking it while a short question still lands (CUR-149).
describe("droppedUnclosedThink — tells a capped reasoner apart from a silent one", () => {
	it("TRUE when the budget ran out mid-reasoning: an unclosed block is all there was", () => {
		expect(droppedUnclosedThink("<think>still working through the four parts and then")).toBe(true);
	});

	it("FALSE when the model simply returned nothing — a different failure with a different fix", () => {
		expect(droppedUnclosedThink("")).toBe(false);
		expect(droppedUnclosedThink("   ")).toBe(false);
	});

	it("FALSE when an answer survived, however much reasoning preceded it", () => {
		expect(droppedUnclosedThink("<think>long chain</think>Bern.")).toBe(false);
	});

	it("TRUE when reasoning closed once and then ran out again — still no answer", () => {
		expect(droppedUnclosedThink("<think>first pass</think><think>second pass, cut off")).toBe(true);
	});
});

describe("stripThink", () => {
	it("strips a complete <think>…</think> block, keeps the answer", () => {
		expect(stripThink("<think>reasoning here</think>The answer.")).toBe("The answer.");
	});

	it("strips an UNCLOSED trailing <think> (model hit the token cap mid-reasoning)", () => {
		// The pasted-bug case: a thinking panelist truncated before </think> must NOT leak its chain-of-
		// thought as the take.
		const truncated =
			"<think>Here's a thinking process:\nDeconstruct the question...\nResearch models...";
		expect(stripThink(truncated)).toBe("");
	});

	it("keeps a real answer that came AFTER a closed think block even if no second close", () => {
		expect(stripThink("<think>plan</think>Real answer body.")).toBe("Real answer body.");
	});

	it("returns empty for a pure-reasoning truncation (caller then drops the panelist)", () => {
		expect(stripThink("<think>still thinking, never answered")).toBe("");
	});

	it("is a no-op for a plain answer with no think block", () => {
		expect(stripThink("Just a normal answer.")).toBe("Just a normal answer.");
	});

	it("handles multiple complete blocks", () => {
		expect(stripThink("<think>a</think>One. <think>b</think>Two.")).toBe("One. Two.");
	});
});
