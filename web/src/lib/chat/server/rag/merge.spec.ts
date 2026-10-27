import { describe, it, expect } from "vitest";
import { mergeRagEvidence } from "./evidence";
import { cosine } from "./embed";
import type { RagSource } from "$lib/chat/types/Rag";

const hit = (over: Partial<Omit<RagSource, "n">>): Omit<RagSource, "n"> => ({
	title: "T",
	snippet: "S",
	engine: "Potluck",
	...over,
});

describe("mergeRagEvidence", () => {
	it("numbers sources sequentially and renders a citable evidence block", () => {
		const ctx = mergeRagEvidence(
			"q",
			[
				hit({ title: "Cloud Compute", snippet: "GPU services." }),
				hit({
					title: "EPFL launches LLMs",
					snippet: "Meditron.",
					engine: "SyftHub:EPFL",
					url: "https://x",
				}),
			],
			undefined
		);
		expect(ctx.sources.map((s) => s.n)).toEqual([1, 2]);
		expect(ctx.evidence).toContain("[1] Cloud Compute (Potluck)");
		expect(ctx.evidence).toContain("[2] EPFL launches LLMs (SyftHub:EPFL)");
		expect(ctx.evidence).toContain("https://x");
		expect(ctx.vaultSynthesis).toBeUndefined();
	});

	it("keeps vault synthesis separate from numbered sources", () => {
		const ctx = mergeRagEvidence("q", [], "Charlie Chaplin lived in Vevey.");
		expect(ctx.sources).toHaveLength(0);
		expect(ctx.evidence).toBe("");
		expect(ctx.vaultSynthesis).toBe("Charlie Chaplin lived in Vevey.");
	});
});

describe("cosine", () => {
	it("is 1 for identical vectors and 0 for orthogonal/mismatched", () => {
		expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosine([1, 2, 3], [1, 2])).toBe(0); // length mismatch → 0
	});
});
