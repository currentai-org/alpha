import { describe, expect, it } from "vitest";
import { badgeLabel, findingCounts, NEXT_STEP } from "../journeyGallery";

const note = { area: "layout", severity: "minor" as const, observation: "a decorative graphic overlaps the nav" };

describe("badgeLabel (CUR-1707)", () => {
	it("counts the minor notes on a clean card, so a skimmer who trusts the badge still sees them", () => {
		expect(badgeLabel({ state: "clean", findings: [], pm: { watched: true, reason: null, findings: [note, note] } })).toBe(
			"Clean · 2 notes"
		);
		expect(badgeLabel({ state: "clean", findings: [], pm: { watched: true, reason: null, findings: [note] } })).toBe(
			"Clean · 1 note"
		);
	});

	it("reads plain Clean only when nobody watching found anything", () => {
		expect(badgeLabel({ state: "clean", findings: [], pm: { watched: true, reason: null, findings: [] } })).toBe("Clean");
		expect(badgeLabel({ state: "clean", findings: [], pm: null })).toBe("Clean");
	});

	it("leaves every state but clean and findings with its own word, whatever the critique found", () => {
		expect(badgeLabel({ state: "unproven", pm: { watched: true, reason: null, findings: [note] }, findings: [] })).toBe(
			"Unproven"
		);
	});
});

const step = (n: number, conclusion: "product" | "doc" | "unseen" | "not-run" | "inconclusive") => ({
	step: n,
	conclusion,
	observation: "x",
});
const annoying = { ...note, severity: "annoying" as const };

describe("a findings badge separates breakage from what nobody checked (CUR-2896)", () => {
	it("counts a product step and a filed critique as broken, and a doc error and an unseen step apart from it", () => {
		const j = {
			state: "findings" as const,
			findings: [step(3, "product"), step(4, "doc"), step(6, "unseen"), step(7, "not-run")],
			pm: { watched: true, reason: null, findings: [annoying, note] },
		};
		expect(findingCounts(j)).toEqual({ broken: 2, doc: 1, unchecked: 2 });
		expect(badgeLabel(j)).toBe("2 broken · 1 doc out of date · 2 not checked");
	});

	it("never calls a card broken when only unseen steps and minor notes are on it", () => {
		const j = { state: "findings" as const, findings: [step(4, "unseen")], pm: { watched: true, reason: null, findings: [note] } };
		expect(badgeLabel(j)).toBe("1 not checked");
	});

	it("does not count a critique that never watched", () => {
		const j = { state: "findings" as const, findings: [step(2, "inconclusive")], pm: { watched: false, reason: "no frames", findings: [annoying] } };
		expect(findingCounts(j).broken).toBe(0);
	});

	it("falls back to the plain word when nothing on the card can be counted", () => {
		expect(badgeLabel({ state: "findings", findings: [], pm: null })).toBe("Findings");
	});

	it("gives every doc-grader conclusion a next step", () => {
		for (const c of ["product", "doc", "unseen", "not-run", "inconclusive"] as const) expect(NEXT_STEP[c]).toMatch(/\w{4}/);
	});
});
