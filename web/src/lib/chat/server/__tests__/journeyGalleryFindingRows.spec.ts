import { describe, expect, it } from "vitest";
import { findingOwner, gradedRecordingIndex, recordingRefs } from "../../shared/journeyGallery";

const card = {
	journey: "A3",
	project: "A3. My data stays mine, and I can take it with me",
	doc: "a3-my-data.md",
	spec: "web/e2e/scenarios/data-portability.spec.ts",
};

describe("findingOwner: every finding row names who it belongs to", () => {
	it("hands a broken step, an inconclusive one and a product-critique finding to the journey's project", () => {
		const project = "the A3. My data stays mine, and I can take it with me project";
		expect(findingOwner(card, { conclusion: "product" })).toBe(project);
		expect(findingOwner(card, { conclusion: "inconclusive" })).toBe(project);
		expect(findingOwner(card)).toBe(project);
	});

	it("names the journey doc for a doc finding, and the spec for a step a test should have walked", () => {
		expect(findingOwner(card, { conclusion: "doc" })).toContain("journey doc (docs/journeys/a3-my-data.md)");
		expect(findingOwner(card, { conclusion: "unseen", claim: { kind: "spec", file: "web/e2e/x.spec.ts" } })).toContain(
			"(web/e2e/x.spec.ts)"
		);
		expect(findingOwner(card, { conclusion: "not-run", claim: { kind: "spec" } })).toContain(`(${card.spec})`);
	});

	it("never returns an empty owner, even for a card with no project or doc", () => {
		const bare = { journey: "W9", project: "", doc: "", spec: "" };
		for (const conclusion of ["product", "doc", "unseen", "not-run", "inconclusive"] as const) {
			expect(findingOwner(bare, { conclusion, claim: { kind: "visual" } })).toMatch(/^the W9 project/);
		}
	});
});

describe("recordingRefs: a finding's recording references become links", () => {
	it("finds both shapes the graders write and keeps the prose around them", () => {
		const parts = recordingRefs("After picking it (Recording 2 at 14.6s), and again in recording 1, 4.0s.");
		expect(parts.map((p) => p.text).join("")).toBe(
			"After picking it (Recording 2 at 14.6s), and again in recording 1, 4.0s."
		);
		expect(parts.filter((p) => p.ref).map((p) => p.ref)).toEqual([
			{ recording: 2, at: 14.6 },
			{ recording: 1, at: 4 },
		]);
	});

	it("points a range at its start and ignores a recording named with no second", () => {
		const refs = recordingRefs("Recording 1 at 14.1s/15.6s; Recording 1 at phone width (4 frames); Recording 7 shows it")
			.filter((p) => p.ref)
			.map((p) => p.ref);
		expect(refs).toEqual([{ recording: 1, at: 14.1 }]);
	});

	it("returns prose with no reference as one plain part", () => {
		expect(recordingRefs("Nothing to link here.")).toEqual([{ text: "Nothing to link here." }]);
	});
});

describe("gradedRecordingIndex: the grader's Recording k is the k-th graded one", () => {
	const rec = (title: string) => ({ title }) as never;

	it("skips a recording the card shows but the grader never saw", () => {
		const j = { graded: ["b", "c"], recordings: [rec("a-failed"), rec("b"), rec("c")] };
		expect(gradedRecordingIndex(j, 1)).toBe(1);
		expect(gradedRecordingIndex(j, 2)).toBe(2);
	});

	it("tells two walks of one test apart by occurrence", () => {
		const j = { graded: ["t", "t"], recordings: [rec("t"), rec("t")] };
		expect(gradedRecordingIndex(j, 1)).toBe(0);
		expect(gradedRecordingIndex(j, 2)).toBe(1);
	});

	it("is null for a recording number the card does not have, so the reference stays plain text", () => {
		const j = { graded: ["b"], recordings: [rec("b")] };
		expect(gradedRecordingIndex(j, 2)).toBeNull();
		expect(gradedRecordingIndex(j, 0)).toBeNull();
		expect(gradedRecordingIndex({ graded: [], recordings: [rec("x")] }, 1)).toBe(0);
	});
});
