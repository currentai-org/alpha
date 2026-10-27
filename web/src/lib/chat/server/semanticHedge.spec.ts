import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the embedding seam with fixture vectors so the HYBRID logic is deterministic + endpoint-free:
// a "denial-ish" text → [1,0,0] (cosine 1 to the example set, which is also denial-ish → [1,0,0]),
// substance → [0,1,0] (cosine 0). The regex below must match EVERY example sentence so the whole example
// set maps to [1,0,0] (else a substance vector would cosine-1 to a stray [0,1,0] example). cosine is
// provided real so the threshold math is exercised.
vi.mock("$lib/chat/server/rag/embed", () => ({
	embedTexts: vi.fn((texts: string[]) =>
		Promise.resolve(
			texts.map((t) =>
				/cannot|can'?t|unable|internet|web|out of date|last update|consult|live|real-time|knowledge|browse|search/i.test(
					t
				)
					? [1, 0, 0]
					: [0, 1, 0]
			)
		)
	),
	cosine: (a: number[], b: number[]) => {
		let d = 0,
			na = 0,
			nb = 0;
		for (let i = 0; i < a.length; i++) {
			d += a[i] * b[i];
			na += a[i] * a[i];
			nb += b[i] * b[i];
		}
		return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
	},
}));

// §4.4 precompute seam mocked → null so these cases exercise the RUNTIME-embed path against the fixture
// vectors above (the committed guard-vectors.json would otherwise short-circuit the example embed with
// real 384-dim vectors and break the deterministic cosine math).
const precomputedGuardVecs = vi.hoisted(() =>
	vi.fn<(set: string, texts: string[]) => number[][] | null>(() => null)
);
vi.mock("./guardVectors", () => ({ precomputedGuardVecs }));

import { detectRecencyHedgeSemantic, _resetHedgeCache } from "./semanticHedge";
import { embedTexts } from "$lib/chat/server/rag/embed";
import hedgeExamples from "./data/hedgeExamples.json";

describe("semanticHedge — hybrid regex + embedding strip", () => {
	beforeEach(() => {
		_resetHedgeCache(); // clear the process-cached example vectors between cases
		vi.mocked(embedTexts).mockClear();
		precomputedGuardVecs.mockReset();
		precomputedGuardVecs.mockReturnValue(null);
	});
	it("catches a denial the REGEX misses (the hybrid's whole point)", async () => {
		// "I'm just a language model and can't browse the web" is NOT caught by the regex (the "just"
		// breaks the I-anchor) — the embedding pass must catch it.
		const r = await detectRecencyHedgeSemantic(
			"Open-source AI funding grew sharply this year. I'm just a language model and can't browse the web."
		);
		expect(r.hedged).toBe(true);
		expect(r.cleaned).toBe("Open-source AI funding grew sharply this year.");
	});

	it("keeps a purely substantive grounded answer untouched", async () => {
		const r = await detectRecencyHedgeSemantic(
			"Mistral released a new open-weights model. The round closed at fifty million dollars."
		);
		expect(r.hedged).toBe(false);
	});

	it("does not send Current AI proper-noun prose through the semantic hedge classifier", async () => {
		const r = await detectRecencyHedgeSemantic(
			"Current AI is a live map of the open source AI ecosystem. It highlights fragile gaps for contributors."
		);
		expect(r.hedged).toBe(false);
		expect(embedTexts).not.toHaveBeenCalled();
	});

	it("does not send cited source-checking answers through the semantic hedge classifier", async () => {
		const r = await detectRecencyHedgeSemantic(
			"For the current state of AI regulation before a board decision, check these sources: [2] The EU AI Act - current state of play and [4] AI Regulations around the World - 2026."
		);
		expect(r.hedged).toBe(false);
		expect(embedTexts).not.toHaveBeenCalled();
	});

	it("never guts the answer (safe-strip floor) — all-hedge answer returns original", async () => {
		const original = "I cannot search. I'm unable to browse.";
		const r = await detectRecencyHedgeSemantic(original);
		expect(r.cleaned).toBe(original);
	});

	it("bails when the only surviving text is bare citation markers (live bug, 2026-07-04)", async () => {
		// Same fix as hedgeGuard.ts, mirrored here since this is the function actually wired into prod
		// (+server.ts calls detectRecencyHedgeSemantic, not detectRecencyHedge directly).
		const r = await detectRecencyHedgeSemantic(
			"I don't have access to real-time information on this. [1] [2]"
		);
		expect(r.hedged).toBe(true);
		expect(r.keptText).toBe("[1] [2]");
		expect(r.bailedWholeAnswer).toBe(true);
	});

	it("FAILS OPEN to regex-only when embeddings are unavailable", async () => {
		vi.mocked(embedTexts).mockResolvedValueOnce(null); // example-set embed fails
		// the regex-missed denial now survives (no semantic pass) — degrades to today's behavior, no throw.
		const r = await detectRecencyHedgeSemantic(
			"Funding rose this year. I'm just a language model and can't browse the web."
		);
		expect(r.hedged).toBe(false);
	});

	it("uses precomputed example vectors when available — embeds ONLY the answer sentences (§4.4)", async () => {
		// Precompute returns [1,0,0] per example (denial-ish), matching the fixture-vector space above.
		precomputedGuardVecs.mockReturnValue(hedgeExamples.map(() => [1, 0, 0]));
		const r = await detectRecencyHedgeSemantic(
			"Funding rose this year. I'm just a language model and can't browse the web."
		);
		expect(r.hedged).toBe(true);
		expect(precomputedGuardVecs).toHaveBeenCalledWith("hedge", hedgeExamples);
		// The example set was NOT embedded at runtime — the only embed is the pending answer sentences.
		expect(embedTexts).toHaveBeenCalledTimes(1);
	});
});
