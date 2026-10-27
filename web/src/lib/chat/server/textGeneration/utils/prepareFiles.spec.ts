import { describe, expect, it } from "vitest";
import { withoutEmptyAnswers } from "./prepareFiles";

describe("withoutEmptyAnswers", () => {
	it("leaves out a failed turn's empty answer so the re-asked question is accepted", () => {
		const out = withoutEmptyAnswers([
			{ role: "system", content: "s" },
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "" },
			{ role: "user", content: "reworded question" },
		]);
		expect(out.map((m) => m.role)).toEqual(["system", "user", "user"]);
	});

	it("leaves out whitespace-only and null answers that carry no tool calls", () => {
		const out = withoutEmptyAnswers([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "  \n" },
			{ role: "assistant", content: null },
			{ role: "user", content: "q2" },
		]);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("keeps an assistant message with tool calls even when its content is null", () => {
		const call = {
			role: "assistant" as const,
			content: null,
			tool_calls: [{ id: "p00001000", type: "function" as const, function: { name: "calculate", arguments: "{}" } }],
		};
		expect(withoutEmptyAnswers([{ role: "user", content: "q" }, call])).toEqual([{ role: "user", content: "q" }, call]);
	});

	it("keeps every answer that has text", () => {
		const msgs = [
			{ role: "user" as const, content: "q" },
			{ role: "assistant" as const, content: "an answer" },
		];
		expect(withoutEmptyAnswers(msgs)).toEqual(msgs);
	});
});
