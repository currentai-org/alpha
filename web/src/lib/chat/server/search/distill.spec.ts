import { describe, it, expect } from "vitest";
import { distillQuery } from "./distill";

describe("distillQuery", () => {
	it("strips a trailing 'what sources can I check' lookup tail (the EU-AI-Act demo bug)", () => {
		// The bare word "sources" must not match astrophysical sources on arXiv, which return off-topic physics preprints.
		const out = distillQuery(
			"What are the latest developments with the EU AI Act, and what sources can I check?"
		);
		expect(out.toLowerCase()).not.toContain("sources");
		expect(out.toLowerCase()).not.toContain("can i check");
		expect(out).toContain("EU AI Act");
	});

	it("strips a leading lookup verb but keeps the entity", () => {
		expect(distillQuery("can you look up the EU AI Act enforcement timeline?")).toBe(
			"EU AI Act enforcement timeline"
		);
	});

	it("leaves a terse keyword query untouched", () => {
		expect(distillQuery("EU AI Act enforcement 2026")).toBe("EU AI Act enforcement 2026");
	});

	it("does not strip a substantive 'what are…' question (no lookup core)", () => {
		const out = distillQuery("What are the latest developments with the EU AI Act?");
		expect(out).toContain("EU AI Act");
		expect(out).toContain("developments");
	});

	it("falls back to the original when stripping would gut the query (lookup-first phrasing)", () => {
		// Here the entity sits INSIDE the lookup clause; over-stripping is worse than not stripping, so the
		// guard returns the original rather than an empty/degenerate query.
		const q = "what sources can I check for climate data?";
		expect(distillQuery(q)).toBe(q);
	});

	it("keeps who is asking and where: a self-description names the jurisdiction the answer turns on (CUR-2423)", () => {
		for (const [q, place] of [
			["I'm a tenant in England and my landlord wants to evict me. What are my rights?", "England"],
			["I'm a nurse in Ontario, what is the minimum wage?", "Ontario"],
			["As a student in Germany, how do I register my address?", "Germany"],
			["I work in Kenya's tax office. What is the VAT rate?", "Kenya"],
		]) {
			expect(distillQuery(q)).toContain(place);
		}
	});
});
