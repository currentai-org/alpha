import { describe, expect, it } from "vitest";
import {
	BUSY_AFTER,
	BUSY_HOLD,
	BUSY_MARK_STALE_MS,
	CLEAR_AFTER,
	afterAnswer,
	afterFailure,
	busyKeyPrefix,
	isBusy
} from "./modelBusy";

const t0 = new Date("2026-10-15T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

describe("model busy mark", () => {
	it("two failed turns in a row mark a model busy, and one does not ( a visitor's failure and their Retry)", () => {
		let row = afterFailure(undefined, t0);
		expect(isBusy(row, t0)).toBe(false);
		row = afterFailure(row, at(47_000));
		expect(row.consecutiveFailures).toBe(BUSY_HOLD);
		expect(isBusy(row, at(47_000))).toBe(true);
	});

	it("keeps counting failures across a quiet gap, so two failures half an hour apart still mark a model that two turns an hour reach", () => {
		let row = afterFailure(undefined, t0);
		row = afterFailure(row, at(0.5 * HOUR - 1));
		expect(isBusy(row, at(0.5 * HOUR - 1))).toBe(true);
	});

	it("a zero count is never busy", () => {
		expect(isBusy({ consecutiveFailures: 0, updatedAt: t0 }, t0)).toBe(false);
	});

	it("keeps a busy model busy through fewer than CLEAR_AFTER answers, and clears it on the CLEAR_AFTER-th in a row", () => {
		let row = afterFailure(undefined, t0, true);
		for (let i = 1; i < CLEAR_AFTER; i++) {
			row = { consecutiveFailures: afterAnswer(row, at(i)), updatedAt: at(i) };
			expect(isBusy(row, at(i)), `busy after ${i} answer(s)`).toBe(true);
		}
		row = { consecutiveFailures: afterAnswer(row, at(CLEAR_AFTER)), updatedAt: at(CLEAR_AFTER) };
		expect(isBusy(row, at(CLEAR_AFTER))).toBe(false);
	});

	it("starts the CLEAR_AFTER count over when a failure lands between answers, so a lane answering every other call stays out of Auto", () => {
		let row = afterFailure(undefined, t0, true);
		for (let i = 0; i < 10; i++) {
			row = { consecutiveFailures: afterAnswer(row, at(i)), updatedAt: at(i) };
			expect(isBusy(row, at(i)), `cleared by one answer at step ${i}`).toBe(true);
			row = afterFailure(row, at(i));
			expect(row.consecutiveFailures).toBe(BUSY_HOLD);
		}
	});

	it("an answer still wipes a single failed turn that did not mark the model busy", () => {
		const one = afterFailure(undefined, t0);
		expect(afterAnswer(one, t0)).toBe(0);
	});

	it("an answer to a mark that has already lapsed clears it rather than restamping it busy for another stale window", () => {
		const lapsed = afterFailure(undefined, t0, true);
		const later = at(BUSY_MARK_STALE_MS + 1);
		expect(isBusy(lapsed, later)).toBe(false);
		const next = { consecutiveFailures: afterAnswer(lapsed, later), updatedAt: later };
		expect(isBusy(next, later)).toBe(false);
	});

	it("trusts a mark only while its last failure is recent, so a mark nothing has re-checked lapses instead of holding a model off forever", () => {
		const row = { consecutiveFailures: BUSY_AFTER, updatedAt: t0 };
		expect(isBusy(row, at(BUSY_MARK_STALE_MS - 1))).toBe(true);
		expect(isBusy(row, at(BUSY_MARK_STALE_MS))).toBe(false);
	});

	it("re-marks at once on the next failure after a stale mark, since the count was never reset by time", () => {
		const stale = { consecutiveFailures: BUSY_AFTER, updatedAt: t0 };
		const next = afterFailure(stale, at(BUSY_MARK_STALE_MS + 1));
		expect(next.consecutiveFailures).toBe(BUSY_HOLD);
		expect(isBusy(next, at(BUSY_MARK_STALE_MS + 1))).toBe(true);
	});

	it("marks a model busy on one decisive failure (a probe's), and a turn's single failure does not", () => {
		expect(isBusy(afterFailure(undefined, t0, true), t0)).toBe(true);
		expect(isBusy(afterFailure(undefined, t0), t0)).toBe(false);
	});

	it("keeps a spec's scoped marks out of the key range every visitor's page reads", () => {
		const everyone = busyKeyPrefix();
		const scoped = busyKeyPrefix("run-123");
		expect(everyone).toBe("busy:");
		expect(scoped.startsWith(everyone)).toBe(false);
	});
});
