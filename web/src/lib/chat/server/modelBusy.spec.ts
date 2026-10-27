import { describe, expect, it } from "vitest";
import { BUSY_AFTER, BUSY_MARK_STALE_MS, afterFailure, busyKeyPrefix, isBusy } from "./modelBusy";

const t0 = new Date("2026-10-15T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

describe("model busy mark (CUR-4043, CUR-4042)", () => {
	it("two failed turns in a row mark a model busy, and one does not (CUR-4629: a visitor's failure and their Retry)", () => {
		let row = afterFailure(undefined, t0);
		expect(isBusy(row, t0)).toBe(false);
		row = afterFailure(row, at(47_000));
		expect(row.consecutiveFailures).toBe(BUSY_AFTER);
		expect(isBusy(row, at(47_000))).toBe(true);
	});

	it("keeps counting failures across a quiet gap, so two failures half an hour apart still mark a model that two turns an hour reach", () => {
		let row = afterFailure(undefined, t0);
		row = afterFailure(row, at(0.5 * HOUR - 1));
		expect(row.consecutiveFailures).toBe(2);
		expect(isBusy(row, at(0.5 * HOUR - 1))).toBe(true);
	});

	it("only an answer clears the mark: a zero count is never busy", () => {
		expect(isBusy({ consecutiveFailures: 0, updatedAt: t0 }, t0)).toBe(false);
	});

	it("trusts a mark only while its last failure is recent, so a mark nothing has re-checked lapses instead of holding a model off forever", () => {
		const row = { consecutiveFailures: BUSY_AFTER, updatedAt: t0 };
		expect(isBusy(row, at(BUSY_MARK_STALE_MS - 1))).toBe(true);
		expect(isBusy(row, at(BUSY_MARK_STALE_MS))).toBe(false);
	});

	it("re-marks at once on the next failure after a stale mark, since the count was never reset by time", () => {
		const stale = { consecutiveFailures: BUSY_AFTER, updatedAt: t0 };
		const next = afterFailure(stale, at(BUSY_MARK_STALE_MS + 1));
		expect(next.consecutiveFailures).toBe(BUSY_AFTER + 1);
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
