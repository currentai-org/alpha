// The daily cleanup runs in-process wherever the Vercel cron does not, whatever the edition.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDailyCleanupSchedule } from "./dailyCleanupSchedule";

// The contract, written out: the first run lands one to ten minutes after boot, then one a day.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startDailyCleanupSchedule — the daily cleanup runs in-process wherever the Vercel cron does not", () => {
	it("off Vercel, runs once a few minutes after boot and then once a day", async () => {
		const run = vi.fn(async () => {});
		const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, run, random: () => 0 });
		expect(stop).not.toBeNull();
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(DAY - 1);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(2);
		stop!();
	});

	it("jitters the first run inside its window, so replicas started together spread out", async () => {
		const run = vi.fn(async () => {});
		const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, run, random: () => 0.999999 });
		await vi.advanceTimersByTimeAsync(10 * MINUTE - 1_000);
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(run).toHaveBeenCalledTimes(1);
		stop!();
	});

	it("DAILY_CLEANUP_FIRST_RUN_DELAY_MS fixes the first run's delay, for a smoke that cannot wait ten minutes", async () => {
		const run = vi.fn(async () => {});
		const env = { DAILY_CLEANUP_FIRST_RUN_DELAY_MS: "5000" };
		const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, run, random: () => 0.999999, env });
		await vi.advanceTimersByTimeAsync(4_999);
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(1);
		stop!();
	});

	it.each(["", "0", "999", "-5000", "5s", "1e4"])(
		"ignores DAILY_CLEANUP_FIRST_RUN_DELAY_MS=%j and keeps the one-to-ten-minute jitter",
		async (value) => {
			const run = vi.fn(async () => {});
			const env = { DAILY_CLEANUP_FIRST_RUN_DELAY_MS: value };
			const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, run, random: () => 0, env });
			await vi.advanceTimersByTimeAsync(MINUTE - 1);
			expect(run).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(run).toHaveBeenCalledTimes(1);
			stop!();
		}
	);

	it.each([
		["Vercel, where the cron runs it", { dev: false, onVercel: true }],
		["vite dev", { dev: true, onVercel: false }],
	])("does not schedule anything on %s", async (_label, opts) => {
		const run = vi.fn(async () => {});
		expect(startDailyCleanupSchedule({ ...opts, run })).toBeNull();
		await vi.advanceTimersByTimeAsync(2 * DAY);
		expect(run).not.toHaveBeenCalled();
	});

	it("leaves no timer holding the process open", () => {
		const unref = vi.spyOn(globalThis, "setTimeout");
		const stop = startDailyCleanupSchedule({ dev: false, onVercel: false, run: async () => {} });
		const handle = unref.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
		expect(handle?.hasRef?.()).toBe(false);
		stop!();
		unref.mockRestore();
	});
});
