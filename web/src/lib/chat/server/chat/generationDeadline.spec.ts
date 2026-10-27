/**
 * Regression coverage for the hung-generation backstop (see generationDeadline.ts): a model stream
 * that never resolves — even after ctrl.abort() — must hand control back to the route at the hard
 * deadline so it can emit a terminal error and close, instead of surviving to Vercel's 300s kill.
 */
import { describe, expect, it, vi } from "vitest";
import {
	GenerationDeadlineExceeded,
	ScreenAwareDeadline,
	boundedSettle,
	raceGenerationDeadline,
	raceScreenAwareDeadline,
} from "./generationDeadline";

const never = new Promise<never>(() => {});

describe("raceGenerationDeadline", () => {
	it("rejects with GenerationDeadlineExceeded when the work NEVER settles (the hung-stream case)", async () => {
		vi.useFakeTimers();
		try {
			const raced = raceGenerationDeadline(never, 60_000);
			const settled = expect(raced).rejects.toBeInstanceOf(GenerationDeadlineExceeded);
			await vi.advanceTimersByTimeAsync(60_000);
			await settled;
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes the work's result through when it settles in time", async () => {
		await expect(raceGenerationDeadline(Promise.resolve("done"), 60_000)).resolves.toBe("done");
	});

	it("passes the work's rejection through untouched (route bugs must not be masked as timeouts)", async () => {
		const boom = new Error("boom");
		await expect(raceGenerationDeadline(Promise.reject(boom), 60_000)).rejects.toBe(boom);
	});

	it("clears the deadline timer once the work settles (no timer held open after a finished turn)", async () => {
		vi.useFakeTimers();
		try {
			await raceGenerationDeadline(Promise.resolve("ok"), 60_000);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("boundedSettle", () => {
	it("returns the value when the promise settles within the budget", async () => {
		await expect(boundedSettle(Promise.resolve(42), 5_000)).resolves.toBe(42);
	});

	it("resolves undefined when the promise hangs past the budget (cleanup must not re-hang)", async () => {
		vi.useFakeTimers();
		try {
			const settled = boundedSettle(never, 5_000);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(settled).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("swallows a rejection (best-effort cleanup never throws out of the emergency path)", async () => {
		await expect(boundedSettle(Promise.reject(new Error("db down")), 5_000)).resolves.toBeUndefined();
	});
});

// A long paste's screen must not count against the 45s generation watchdog: the clock starts
// when the screen ends, so a turn whose screen took 40s still gets the full budget to answer. (CUR-3749)
describe("ScreenAwareDeadline — the generation clock starts when the screen ends", () => {
	const withFakeTimers = async (fn: () => Promise<void>) => {
		vi.useFakeTimers();
		try {
			await fn();
		} finally {
			vi.useRealTimers();
		}
	};

	it("a 40s screen leaves the full 45s to generate: nothing fires at 45s, it fires at 85s", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(40_000);
			deadline.screenSettled();
			await vi.advanceTimersByTimeAsync(44_999);
			expect(onFire).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("a screen that settles early pulls the deadline in, so an ordinary turn is not given the whole allowance", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(2_000);
			deadline.screenSettled();
			await vi.advanceTimersByTimeAsync(45_000);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("a screen that never settles still ends at base plus the allowance, never later", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(144_999);
			expect(onFire).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("a screen that settles past the allowance gets only the allowance, so the turn ends at once", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(10_000, 5_000);
			const onFire = vi.fn();
			deadline.schedule(onFire, 1_000_000);
			await vi.advanceTimersByTimeAsync(20_000);
			deadline.screenSettled();
			expect(deadline.screenExtensionMs).toBe(5_000);
			expect(deadline.remainingMs()).toBe(-5_000);
		}));

	it("with no allowance (an agent turn) the deadline is exactly the base, as before", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(155_000, 0);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(155_000);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	// An open confirm card holds the clock, inside the room the ladder leaves under MAX_SAFE. (CUR-3983)
	it("a 60s confirm wait moves the deadline 60s later than the same turn with no wait", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(2_000);
			deadline.screenSettled();
			await vi.advanceTimersByTimeAsync(8_000);
			deadline.setHumanWaiting(true);
			await vi.advanceTimersByTimeAsync(60_000);
			deadline.setHumanWaiting(false);
			expect(deadline.humanExtensionMs).toBe(60_000);
			// Without the wait it would have fired at 47s; with it, at 107s.
			await vi.advanceTimersByTimeAsync(36_999);
			expect(onFire).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("a confirm nobody answers still ends the turn at base plus the room, never past MAX_SAFE", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(2_000);
			deadline.screenSettled();
			deadline.setHumanWaiting(true);
			await vi.advanceTimersByTimeAsync(152_999);
			expect(onFire).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("waits share the room with the screen: two waits together get only what the screen left", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			await vi.advanceTimersByTimeAsync(90_000);
			deadline.screenSettled();
			deadline.setHumanWaiting(true);
			await vi.advanceTimersByTimeAsync(15_000);
			deadline.setHumanWaiting(false);
			deadline.setHumanWaiting(true);
			await vi.advanceTimersByTimeAsync(15_000);
			deadline.setHumanWaiting(false);
			expect(deadline.screenExtensionMs + deadline.humanExtensionMs).toBe(110_000);
		}));

	it("a turn with no confirm card ends exactly where it did before", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			const onFire = vi.fn();
			deadline.schedule(onFire);
			await vi.advanceTimersByTimeAsync(2_000);
			deadline.screenSettled();
			deadline.setHumanWaiting(false);
			await vi.advanceTimersByTimeAsync(45_000);
			expect(onFire).toHaveBeenCalledTimes(1);
		}));

	it("a cancelled timer neither fires nor comes back when the screen settles", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(1_000, 1_000);
			const onFire = vi.fn();
			const cancel = deadline.schedule(onFire);
			cancel();
			deadline.screenSettled();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(onFire).not.toHaveBeenCalled();
		}));

	it("raceScreenAwareDeadline gives a hung generation the grace after the screen-shifted deadline", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000);
			const raced = raceScreenAwareDeadline(never, deadline, 15_000);
			let rejected: unknown;
			raced.catch((e) => (rejected = e));
			await vi.advanceTimersByTimeAsync(30_000);
			deadline.screenSettled();
			await vi.advanceTimersByTimeAsync(59_999);
			expect(rejected).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(rejected).toBeInstanceOf(GenerationDeadlineExceeded);
			expect((rejected as GenerationDeadlineExceeded).deadlineMs).toBe(45_000 + 30_000 + 15_000);
		}));
});

describe("ScreenAwareDeadline.extendWhileStreaming — a turn still streaming at 45s runs to the ceiling (CUR-4009)", () => {
	const withFakeTimers = async (fn: () => Promise<void>) => {
		vi.useFakeTimers();
		try {
			await fn();
		} finally {
			vi.useRealTimers();
		}
	};

	it("an extension at the 47s deadline moves the next firing to base plus all the room left (155s), not later", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			const onFire = vi.fn();
			await vi.advanceTimersByTimeAsync(2_000);
			deadline.screenSettled();
			deadline.schedule(() => {
				onFire();
				if (deadline.extendWhileStreaming() > 0) deadline.schedule(onFire);
			});
			await vi.advanceTimersByTimeAsync(45_000);
			expect(onFire).toHaveBeenCalledTimes(1);
			expect(deadline.streamExtensionMs).toBe(110_000 - 2_000);
			await vi.advanceTimersByTimeAsync(107_999);
			expect(onFire).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(onFire).toHaveBeenCalledTimes(2);
		}));

	it("the extension is granted once: a second call adds nothing, so a turn cannot stream forever", () => {
		const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
		deadline.screenSettled();
		expect(deadline.extendWhileStreaming()).toBeGreaterThan(0);
		expect(deadline.extendWhileStreaming()).toBe(0);
	});

	// On the real clock a millisecond can tick between the two remainingMs() reads (CUR-4009 flake).
	it("an agent turn with no room gets no extension (0 ms), so its deadline is unchanged", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(155_000, 0, Date.now, 0);
			const before = deadline.remainingMs();
			expect(deadline.extendWhileStreaming()).toBe(0);
			expect(deadline.remainingMs()).toBe(before);
		}));

	it("a confirm wait taken before the extension shrinks it, so screen + wait + stream never pass roomMs", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			deadline.screenSettled();
			deadline.setHumanWaiting(true);
			await vi.advanceTimersByTimeAsync(30_000);
			deadline.setHumanWaiting(false);
			expect(deadline.extendWhileStreaming()).toBe(110_000 - 30_000);
			expect(
				deadline.screenExtensionMs + deadline.humanExtensionMs + deadline.streamExtensionMs
			).toBe(110_000);
		}));

	it("the hard-unwind race moves with the extension: a hung stream is cut at the new deadline plus grace", () =>
		withFakeTimers(async () => {
			const deadline = new ScreenAwareDeadline(45_000, 100_000, Date.now, 110_000);
			deadline.screenSettled();
			const raced = raceScreenAwareDeadline(never, deadline, 15_000);
			let rejected: unknown;
			raced.catch((e) => (rejected = e));
			await vi.advanceTimersByTimeAsync(45_000);
			deadline.extendWhileStreaming();
			await vi.advanceTimersByTimeAsync(110_000 + 15_000 - 1);
			expect(rejected).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(rejected).toBeInstanceOf(GenerationDeadlineExceeded);
			expect((rejected as GenerationDeadlineExceeded).deadlineMs).toBe(45_000 + 110_000 + 15_000);
		}));
});
