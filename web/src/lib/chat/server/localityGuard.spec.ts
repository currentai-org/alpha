import { describe, it, expect } from "vitest";
import { isLocalityQuery } from "./localityGuard";

describe("isLocalityQuery() — gates the cultural/jurisdictional lens", () => {
	it("fires on the Geneva demo beat (via 'public institutions')", () => {
		expect(
			isLocalityQuery(
				"I work in humanitarian policy in Geneva. Can this help me understand AI governance frameworks affecting public institutions?"
			)
		).toBe(true);
	});

	it("fires on civic / legal / rights / immigration questions", () => {
		for (const q of [
			"How do I apply for asylum?",
			"What are my rights as a citizen here?", // 'citizen'
			"Explain the visa requirements",
			"What does the regulation require of public services?",
			"human rights obligations for governments",
		]) {
			expect(isLocalityQuery(q), q).toBe(true);
		}
	});

	it("does NOT fire on tech-overloaded false positives or context-free questions", () => {
		for (const q of [
			"Explain the policy gradient in reinforcement learning", // 'policy' deliberately excluded
			"What is the second law of thermodynamics?", // bare 'law' excluded
			"What is data governance in an ML pipeline?", // bare 'governance' excluded
			"How do I set file access rights in Linux?", // bare 'rights' excluded
			"What is photosynthesis?",
			"A farmer in Rwanda asks about drought-resistant crops", // honest-limits beat, not locality
		]) {
			expect(isLocalityQuery(q), q).toBe(false);
		}
	});

	// Real locality-dependent questions the regex misses because they
	// carry none of its trigger words — the recall gap localitySemantic.ts's embedding pass exists to
	// close. Pinned here (not as a "should fire" expectation — that's the semantic test's job) so a
	// future regex tweak doesn't accidentally start relying on these matching when they shouldn't.
	it("does NOT fire on the dogfood-reported phrasings (documents the gap the semantic hybrid closes)", () => {
		for (const q of ["Should I plead guilty?", "Is nuclear energy a good idea?"]) {
			expect(isLocalityQuery(q), q).toBe(false);
		}
	});
});
