import { describe, it, expect } from "vitest";
import { shapeQueryForEngine } from "./shapeQuery";

describe("shapeQueryForEngine", () => {
	it("strips leading question framing for the entity engines (Wikipedia/Wikinews)", () => {
		expect(shapeQueryForEngine("what is the EU AI Act", "Wikipedia")).toBe("EU AI Act");
		expect(shapeQueryForEngine("who is Ada Lovelace", "Wikinews")).toBe("Ada Lovelace");
		expect(shapeQueryForEngine("tell me about quantum computing?", "Wikipedia")).toBe(
			"quantum computing"
		);
	});

	it("passes the query through UNCHANGED for non-entity engines", () => {
		for (const engine of ["Firecrawl", "OpenAlex", "arXiv", "Hugging Face"] as const) {
			expect(shapeQueryForEngine("what is the EU AI Act", engine)).toBe("what is the EU AI Act");
		}
	});

	it("guardrail: keeps the base when reshaping would leave <2 tokens", () => {
		// "what is X" → "X" is a single token → keep the base rather than over-trim to one word.
		expect(shapeQueryForEngine("what is transformers", "Wikipedia")).toBe("what is transformers");
	});

	it("guardrail: an already-terse entity query is unchanged", () => {
		expect(shapeQueryForEngine("EU AI Act timeline", "Wikipedia")).toBe("EU AI Act timeline");
	});
});
