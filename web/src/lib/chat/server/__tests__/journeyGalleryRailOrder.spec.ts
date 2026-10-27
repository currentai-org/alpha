import { describe, expect, it } from "vitest";
import { journeyGroup, journeyGroups, runVerdict, sortFailuresFirst, type JourneyState } from "../journeyGallery";

type JourneyRecording = Parameters<typeof runVerdict>[0][number]["recordings"][number];

const card = (journey: string, state: JourneyState, statuses: string[] = ["passed"]) => ({
	journey,
	state,
	// Only the fields these helpers read; the rest of a recording is irrelevant to ordering and verdicts.
	recordings: statuses.map(
		(status, i) => ({ slug: `${journey}-${i}`, title: `${journey} test ${i}`, status }) as unknown as JourneyRecording
	),
});

describe("sortFailuresFirst (CUR-3076)", () => {
	it("puts findings, flaky and partly graded journeys ahead of clean ones, and no-doc journeys last", () => {
		const order = sortFailuresFirst([
			card("A1", "clean"),
			card("X9", "not-covered"),
			card("A2", "findings"),
			card("F9", "not-run"),
			card("C1", "flaky"),
		]).map((j) => j.journey);
		expect(order).toEqual(["A2", "C1", "F9", "A1", "X9"]);
	});

	it("keeps the manifest's order among journeys in the same state, and leaves its input alone", () => {
		const input = [card("A3", "clean"), card("A1", "clean"), card("A2", "findings")];
		expect(sortFailuresFirst(input).map((j) => j.journey)).toEqual(["A2", "A3", "A1"]);
		expect(input.map((j) => j.journey)).toEqual(["A3", "A1", "A2"]);
	});
});

describe("journeyGroup", () => {
	it("groups by the id's leading letters, so A1 and A10 share a group and F9 does not", () => {
		expect(journeyGroup("A1")).toBe("A");
		expect(journeyGroup("A10")).toBe("A");
		expect(journeyGroup("F9")).toBe("F");
		expect(journeyGroup("ab3")).toBe("AB");
	});

	it("keeps an id with no leading letters as its own group rather than dropping it", () => {
		expect(journeyGroup("42")).toBe("42");
	});

	it("lists a run's groups once each, alphabetically", () => {
		expect(journeyGroups([card("F9", "clean"), card("A1", "clean"), card("A10", "clean")])).toEqual(["A", "F"]);
	});
});

describe("runVerdict (CUR-3076)", () => {
	it("asks for a look when a journey has findings, naming the count", () => {
		expect(runVerdict([card("A1", "findings"), card("A2", "clean")])).toEqual({
			tone: "attention",
			text: "1 journey asks for a look",
		});
	});

	it("asks for a look when a recording failed on a journey that graded clean", () => {
		expect(runVerdict([card("A1", "clean", ["passed", "failed"])])).toEqual({
			tone: "attention",
			text: "1 recording failed",
		});
	});

	it("does not count a skipped recording as failed", () => {
		expect(runVerdict([card("A1", "clean", ["skipped"])]).tone).toBe("clean");
	});

	it("reads unmeasured, not clean, when a documented journey did not run", () => {
		expect(runVerdict([card("A1", "clean"), card("F9", "not-run")])).toEqual({
			tone: "unmeasured",
			text: "Nothing asks for a look, but 1 journey went unmeasured",
		});
	});

	it("reads clean when the only journeys without a verdict have no doc, which no re-run can grade", () => {
		expect(runVerdict([card("A1", "clean"), card("X9", "not-covered")])).toEqual({
			tone: "clean",
			text: "Every graded journey is clean",
		});
	});
});
