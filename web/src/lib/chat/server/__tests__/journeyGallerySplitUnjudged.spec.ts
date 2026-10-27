import { describe, expect, it } from "vitest";

import { splitUnjudgedByDoc, withUndocumentedAsNotCovered, type JourneyCard } from "../journeyGallery";

/**
 * Named for the contract, not the behaviour: what breaks this is a no-doc journey counted as a run
 * gap, or a documented journey counted as a doc-authoring gap.
 *
 * Fixtures mirror a real board: A7 has a doc
 * (`a7-everyday-jobs.md`) and a skipped recording; P1/P2 are undocumented persona recordings
 * (CUR-1574, `doc: ""`); A9/A10/F1/F4/F7/F8/R1/R2/W2/W3/W4 are register-only, with no doc and no
 * recording at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the three fields the splitter reads
const card = (journey: string, doc: string, state: JourneyCard["state"]): any => ({ journey, doc, state });

describe("splitUnjudgedByDoc", () => {
	it("does not report a no-doc journey as a run gap", () => {
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc([card("A9", "", "not-covered")]);
		expect(ranButNoVerdict).toEqual([]);
		expect(noDocYet).toEqual(["A9"]);
	});

	it("does not report a documented journey's run gap as a doc-authoring gap", () => {
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc([card("A7", "a7-everyday-jobs.md", "not-graded")]);
		expect(ranButNoVerdict).toEqual(["A7"]);
		expect(noDocYet).toEqual([]);
	});

	it("keys on doc, not on not-covered — an undocumented persona recording is still a doc gap even in not-graded", () => {
		// P1/P2 carry a recording (even a skipped one) so they land in not-graded, not
		// not-covered — the state most readers would reach for is the wrong signal here. (CUR-1574)
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc([
			card("P1", "", "not-graded"),
			card("P2", "", "not-graded"),
		]);
		expect(ranButNoVerdict).toEqual([]);
		expect(noDocYet).toEqual(["P1", "P2"]);
	});

	it("ignores a judged journey entirely, even with no doc", () => {
		// Shouldn't happen in practice (a doc-less journey can't reach `clean`), but the function
		// must not invent a bucket for a state UNJUDGED never names.
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc([card("F9", "", "clean")]);
		expect(ranButNoVerdict).toEqual([]);
		expect(noDocYet).toEqual([]);
	});

	it("reproduces the real 11:48Z board: 1 run gap, 13 doc gaps", () => {
		const journeys = [
			card("A7", "a7-everyday-jobs.md", "not-graded"),
			card("P1", "", "not-graded"),
			card("P2", "", "not-graded"),
			...["A9", "A10", "F1", "F4", "F7", "F8", "R1", "R2", "W2", "W3", "W4"].map((j) => card(j, "", "not-covered")),
		];
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc(journeys);
		expect(ranButNoVerdict).toEqual(["A7"]);
		expect(noDocYet).toHaveLength(13);
		expect(noDocYet).toEqual(expect.arrayContaining(["P1", "P2", "A9", "A10", "F1", "F4", "F7", "F8", "R1", "R2", "W2", "W3", "W4"]));
	});

	it("returns two empty lists for an empty board rather than throwing", () => {
		expect(splitUnjudgedByDoc([])).toEqual({ ranButNoVerdict: [], noDocYet: [] });
	});
});

describe("withUndocumentedAsNotCovered", () => {
	// The state pills count by state and the "no doc yet" sentence by doc (CUR-2266). Fixture is a
	// develop board's shape: A9 recorded with no doc (not-graded), A7 documented and ungraded, F1
	// register-only.
	it("makes the 'no journey doc' pill count equal the 'no doc yet' sentence", () => {
		const journeys = withUndocumentedAsNotCovered([
			card("A9", "", "not-graded"),
			card("A7", "a7-everyday-jobs.md", "not-graded"),
			card("F1", "", "not-covered"),
			card("P1", "", "not-run"),
			card("A1", "a1-sign-in.md", "clean"),
		]);
		const pill = journeys.filter((j: { state: string }) => j.state === "not-covered").length;
		const { ranButNoVerdict, noDocYet } = splitUnjudgedByDoc(journeys);
		expect(pill).toBe(noDocYet.length);
		expect(journeys.filter((j: { state: string }) => j.state === "not-graded" || j.state === "not-run").length).toBe(
			ranButNoVerdict.length
		);
	});

	it("leaves a documented card's state alone, judged or not", () => {
		const journeys = withUndocumentedAsNotCovered([
			card("A7", "a7-everyday-jobs.md", "not-graded"),
			card("A1", "a1-sign-in.md", "clean"),
		]);
		expect(journeys.map((j: { state: string }) => j.state)).toEqual(["not-graded", "clean"]);
	});
});
