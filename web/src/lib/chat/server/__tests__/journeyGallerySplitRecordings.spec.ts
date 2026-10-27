import { describe, expect, it } from "vitest";

import { splitRecordingsByOutcome } from "../journeyGallery";

/**
 * Named for the contract, not the behaviour (a test's name states the contract): what breaks this is a skip getting
 * counted as a failure, so that is what the test names say.
 *
 * The fixtures mirror a real board: A7 is `@preview-only`, P1 and
 * P2 are persona runs, all three skipped, and none may be announced on the page as "3 recordings
 * failed" (CUR-1816).
 */
const rec = (title: string, status: string, expectedFailure = false) => ({
	slug: title,
	title,
	status,
	expectedFailure,
	startedAt: "2026-09-22T11:18:45Z",
	project: "chromium",
	durationMs: 0,
	bytes: 0,
	file: `journey-gallery/x/${title}.webm`,
	personaTrace: null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the two fields the splitter reads
const card = (journey: string, recordings: ReturnType<typeof rec>[]): any => ({ journey, recordings });

describe("splitRecordingsByOutcome", () => {
	// sign-in.spec.ts's second-sign-in test is `test.fail()` while the login page crashes on
	// `?error=` (CUR-1813); its recording is an expected failure, not a failed one. (CUR-2234)
	it("does not report an expected failure (test.fail) as failed", () => {
		const { failed, expected } = splitRecordingsByOutcome([
			card("A1", [
				rec("a second sign-in on an already-used email is told plainly", "failed", true),
			]),
		]);
		expect(failed).toEqual([]);
		expect(expected).toEqual([
			{ journey: "A1", title: "a second sign-in on an already-used email is told plainly", status: "expected failure" },
		]);
	});

	it("does not report a skipped recording as failed", () => {
		const { failed, skipped } = splitRecordingsByOutcome([
			card("A7", [rec("the agent control names its current mode", "skipped")]),
			card("P1", [rec("a chaos-monkey persona drives Alpha", "skipped")]),
			card("P2", [rec("a munchkin persona grinds one surface", "skipped")]),
		]);
		expect(failed).toEqual([]);
		expect(skipped.map((r) => r.journey)).toEqual(["A7", "P1", "P2"]);
	});

	it("reports a real failure as failed", () => {
		const { failed, skipped } = splitRecordingsByOutcome([card("A1", [rec("sign in", "failed")])]);
		expect(failed.map((r) => r.journey)).toEqual(["A1"]);
		expect(skipped).toEqual([]);
	});

	it("counts timedOut and interrupted as failures, because they are results", () => {
		const { failed, skipped } = splitRecordingsByOutcome([
			card("A2", [rec("language", "timedOut")]),
			card("A3", [rec("export", "interrupted")]),
		]);
		expect(failed.map((r) => r.status).sort()).toEqual(["interrupted", "timedOut"]);
		expect(skipped).toEqual([]);
	});

	it("treats a status Playwright adds later as a failure, so it surfaces instead of going quiet", () => {
		// The safe direction for an unknown value: something to look at, never something folded into
		// the quieter skipped sentence where nobody chases it.
		const { failed, skipped } = splitRecordingsByOutcome([card("F9", [rec("new", "someFutureStatus")])]);
		expect(failed).toHaveLength(1);
		expect(skipped).toEqual([]);
	});

	it("ignores passed recordings entirely", () => {
		const { failed, skipped } = splitRecordingsByOutcome([
			card("F5", [rec("one look", "passed"), rec("phone width", "passed")]),
		]);
		expect(failed).toEqual([]);
		expect(skipped).toEqual([]);
	});

	it("separates the two within a single journey that has both", () => {
		const { failed, skipped } = splitRecordingsByOutcome([
			card("A3", [rec("export", "passed"), rec("delete", "failed"), rec("mobile", "skipped")]),
		]);
		expect(failed.map((r) => r.title)).toEqual(["delete"]);
		expect(skipped.map((r) => r.title)).toEqual(["mobile"]);
	});

	it("carries the journey id and title through, which is all the summary prints", () => {
		const { skipped } = splitRecordingsByOutcome([card("A7", [rec("one tap advances it", "skipped")])]);
		expect(skipped[0]).toEqual({ journey: "A7", title: "one tap advances it", status: "skipped" });
	});

	it("returns empty lists for an empty board rather than throwing", () => {
		expect(splitRecordingsByOutcome([])).toEqual({ failed: [], skipped: [], expected: [] });
	});
});
