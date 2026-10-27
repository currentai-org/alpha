import { describe, it, expect } from "vitest";
import {
	usesModelClassifier,
	shouldRunSearch,
	resolveTriggerStrategy,
	SEARCH_TRIGGER_STRATEGY,
} from "./triggerStrategy";

describe("resolveTriggerStrategy — env value → strategy", () => {
	it("accepts all four valid strategies (case/space-insensitive)", () => {
		expect(resolveTriggerStrategy("tool")).toBe("tool");
		expect(resolveTriggerStrategy("MODEL")).toBe("model");
		expect(resolveTriggerStrategy("  heuristic ")).toBe("heuristic");
		expect(resolveTriggerStrategy("margin")).toBe("margin");
	});
	it("falls back to the safe code default for unset/unknown values", () => {
		expect(resolveTriggerStrategy(undefined)).toBe(SEARCH_TRIGGER_STRATEGY);
		expect(resolveTriggerStrategy("")).toBe(SEARCH_TRIGGER_STRATEGY);
		expect(resolveTriggerStrategy("agentic")).toBe(SEARCH_TRIGGER_STRATEGY);
		// the safe default is heuristic — never silently enable model calls
		expect(SEARCH_TRIGGER_STRATEGY).toBe("heuristic");
	});
});

describe("usesModelClassifier", () => {
	it("is true for model and tool strategies", () => {
		expect(usesModelClassifier("model")).toBe(true);
		// "tool" degrades to the classifier until tool-calling is wired.
		expect(usesModelClassifier("tool")).toBe(true);
	});
	// Omitted: margin is the production strategy (CUR-147), and this gate is
	// what decides whether its classifier is called at all. False here means the round-trip never
	// happens and every turn silently falls to the recency regex.
	it("is true for margin — the classifier round-trip is the whole gate", () => {
		expect(usesModelClassifier("margin")).toBe(true);
	});
	it("is false for the heuristic-only strategy", () => {
		expect(usesModelClassifier("heuristic")).toBe(false);
	});
});

describe("shouldRunSearch — signal composition", () => {
	it("under heuristic strategy, a heuristic hit searches", () => {
		expect(shouldRunSearch({ heuristicHit: true, strategy: "heuristic" })).toBe(true);
	});

	// "does the chat I'm having now carry over at sign-in?" matches the regex's bare "now",
	// and the classifier, which reads the whole question, says no and wins. (CUR-2372)
	it("under model and tool, a classifier no is not overridden by a recency-regex hit", () => {
		for (const strategy of ["model", "tool"] as const) {
			expect(
				shouldRunSearch({ heuristicHit: true, classifierHit: false, classifierOk: true, strategy })
			).toBe(false);
		}
	});

	it("under model and tool, the recency regex decides only when the classifier gave no verdict", () => {
		for (const strategy of ["model", "tool"] as const) {
			for (const heuristicHit of [true, false]) {
				expect(
					shouldRunSearch({ heuristicHit, classifierHit: false, classifierOk: false, strategy })
				).toBe(heuristicHit);
				expect(shouldRunSearch({ heuristicHit, strategy })).toBe(heuristicHit);
			}
		}
	});

	it("under heuristic strategy, a heuristic miss never searches (classifier ignored)", () => {
		expect(shouldRunSearch({ heuristicHit: false, strategy: "heuristic" })).toBe(false);
		expect(
			shouldRunSearch({ heuristicHit: false, classifierHit: true, strategy: "heuristic" })
		).toBe(false);
	});

	it("under model strategy, the classifier's verdict decides", () => {
		expect(shouldRunSearch({ heuristicHit: false, classifierHit: true, strategy: "model" })).toBe(
			true
		);
		expect(shouldRunSearch({ heuristicHit: false, classifierHit: false, strategy: "model" })).toBe(
			false
		);
	});

	// "margin" — the embedding gate is the ONLY decider (CUR-2109). Neither regex is consulted: the
	// gate alone covers every holdout bucket they cover, explicit asks included. When the gate gives no
	// verdict (classifierOk === false) the turn SEARCHES, because a missed search costs more than an
	// extra one; the caller logs each such turn as a departure.
	it("under margin, the gate's verdict decides and the recency regex is ignored either way", () => {
		expect(shouldRunSearch({ heuristicHit: false, classifierHit: true, strategy: "margin" })).toBe(
			true
		);
		expect(shouldRunSearch({ heuristicHit: true, classifierHit: false, strategy: "margin" })).toBe(
			false
		);
	});

	it("under margin, no verdict from the gate means search, whatever the recency regex says", () => {
		for (const heuristicHit of [true, false]) {
			expect(
				shouldRunSearch({ heuristicHit, classifierHit: false, classifierOk: false, strategy: "margin" })
			).toBe(true);
		}
	});

	it("under margin, the explicit-lookup regex cannot override the gate's no", () => {
		expect(
			shouldRunSearch({
				heuristicHit: false,
				classifierHit: false,
				strategy: "margin",
				explicitLookupHit: true,
			})
		).toBe(false);
	});

	// explicitLookupHit (isExplicitLookupRequest — see recency.ts) is a SEPARATE signal from
	// heuristicHit: the user's own stated ask to search. A follow-up like "why not look online to find
	// out?" matches the recency heuristic, but a classifier seeing only the bare follow-up can say no.
	// In force for the strategies whose decider can miss it.
	it("an explicit lookup ask overrides the model and heuristic strategies", () => {
		expect(
			shouldRunSearch({
				heuristicHit: false,
				classifierHit: false,
				strategy: "model",
				explicitLookupHit: true,
			})
		).toBe(true);
		expect(
			shouldRunSearch({ heuristicHit: false, strategy: "heuristic", explicitLookupHit: true })
		).toBe(true);
	});

	it("omitting explicitLookupHit changes nothing (existing behavior is untouched)", () => {
		expect(shouldRunSearch({ heuristicHit: true, classifierHit: false, strategy: "margin" })).toBe(
			false
		);
	});
});
