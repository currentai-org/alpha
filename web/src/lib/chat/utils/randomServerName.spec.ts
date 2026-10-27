import { describe, it, expect } from "vitest";
import { randomServerName } from "./randomServerName";

// The managed-server form opens with one of these already in the field. It is a label a
// person has to recognise in a list later, so the properties worth pinning are about readability,
// not randomness. (CUR-3168)
describe("randomServerName", () => {
	it("reads as two capitalised words", () => {
		expect(randomServerName()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
	});

	it("varies between calls", () => {
		// 1,024 combinations, so 50 draws collapsing to one value would mean the picker is stuck —
		// which would show up as every machine being suggested the same name.
		const seen = new Set(Array.from({ length: 50 }, randomServerName));
		expect(seen.size).toBeGreaterThan(1);
	});

	it("never suggests an empty name", () => {
		// The Pair button is disabled on an empty name, so a blank suggestion would present a form
		// that looks ready and cannot be submitted.
		for (let i = 0; i < 100; i++) expect(randomServerName().trim()).not.toBe("");
	});
});
