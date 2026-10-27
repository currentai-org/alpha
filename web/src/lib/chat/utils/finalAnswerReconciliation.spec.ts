import { describe, expect, test } from "vitest";
import { reconcileFinalAnswerText } from "./finalAnswerReconciliation";

describe("reconcileFinalAnswerText", () => {
	test("keeps already-identical streamed text byte-stable", () => {
		expect(reconcileFinalAnswerText("The answer.", "The answer.")).toEqual({ type: "noop" });
	});

	test("appends only the delta when the final answer extends the streamed prefix", () => {
		expect(reconcileFinalAnswerText("The answer", "The answer.")).toEqual({
			type: "append",
			text: ".",
		});
	});

	test("replaces when an honesty guard removed a bad prefix", () => {
		const streamed =
			"These sources are hypothetical examples. The EU AI Act entered force in 2024.";
		const final = "The EU AI Act entered force in 2024.";

		expect(streamed.endsWith(final)).toBe(true);
		expect(reconcileFinalAnswerText(streamed, final)).toEqual({
			type: "replace",
			text: final,
		});
	});

	test("replaces when the final answer is empty", () => {
		expect(reconcileFinalAnswerText("For sources, check [1].", "")).toEqual({
			type: "replace",
			text: "",
		});
	});
});
