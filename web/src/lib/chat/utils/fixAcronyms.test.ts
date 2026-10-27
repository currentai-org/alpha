import { describe, expect, it } from "vitest";
import { fixAcronymExpansions } from "./fixAcronyms";

describe("fixAcronymExpansions() — correct-or-strip confabulated expansions", () => {
	it("corrects a KNOWN acronym to its real glossary expansion", () => {
		expect(fixAcronymExpansions("Use PEFT (Pathways Embedding Fine-Tuning) for this")).toBe(
			"Use PEFT (Parameter-Efficient Fine-Tuning) for this"
		);
	});

	it("strips an UNKNOWN/ambiguous acronym's expansion to bare", () => {
		expect(fixAcronymExpansions("Try vLLM (Vector-Level Language Model) for serving")).toBe(
			"Try vLLM for serving"
		);
	});

	it("leaves genuine non-acronym parentheticals untouched", () => {
		expect(fixAcronymExpansions("the cat (a small animal)")).toBe("the cat (a small animal)");
	});

	it("keeps genuine asides (e.g., i.e., numbers, urls)", () => {
		expect(fixAcronymExpansions("formats (e.g. PNG and JPG)")).toBe("formats (e.g. PNG and JPG)");
	});

	it("handles the mid-stream UNCLOSED '(…' without flicker", () => {
		expect(fixAcronymExpansions("serving with vLLM (Vector-Level")).toBe("serving with vLLM");
		expect(fixAcronymExpansions("training with PEFT (Pathways")).toBe(
			"training with PEFT (Parameter-Efficient Fine-Tuning)"
		);
	});

	it("is a no-op on empty input", () => {
		expect(fixAcronymExpansions("")).toBe("");
	});
});
