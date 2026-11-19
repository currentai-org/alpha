// off Vercel, every server process refreshes its own state on a timer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startProcessKeepalive } from "./keepalive";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startProcessKeepalive — each process keeps its own flags, registry and DB fresh", () => {
	it("runs a pass at start and one per interval after, until stopped", async () => {
		const tick = vi.fn(async () => {});
		const stop = startProcessKeepalive({ tick, intervalMs: 1_000, onVercel: false });
		expect(stop).not.toBeNull();
		expect(tick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(tick).toHaveBeenCalledTimes(4);
		stop!();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(tick).toHaveBeenCalledTimes(4);
	});

	it("two processes each run their own passes (one interval per process, not one shared)", async () => {
		const a = vi.fn(async () => {});
		const b = vi.fn(async () => {});
		const stopA = startProcessKeepalive({ tick: a, intervalMs: 1_000, onVercel: false });
		const stopB = startProcessKeepalive({ tick: b, intervalMs: 1_000, onVercel: false });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(a).toHaveBeenCalledTimes(3);
		expect(b).toHaveBeenCalledTimes(3);
		stopA!();
		stopB!();
	});

	it("does not start a pass while the previous one is still running, and survives a rejecting pass", async () => {
		let release!: () => void;
		const tick = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
			.mockRejectedValueOnce(new Error("posthog down"))
			.mockResolvedValue(undefined);
		const stop = startProcessKeepalive({ tick, intervalMs: 1_000, onVercel: false });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(tick).toHaveBeenCalledTimes(1); // the first pass is still out
		release();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(tick).toHaveBeenCalledTimes(2); // the rejecting pass
		await vi.advanceTimersByTimeAsync(1_000);
		expect(tick).toHaveBeenCalledTimes(3); // and the timer carried on after it
		stop!();
	});

	it("never runs on Vercel, where a timer would thaw inside a later request", async () => {
		const tick = vi.fn(async () => {});
		expect(startProcessKeepalive({ tick, intervalMs: 1_000, onVercel: true })).toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(tick).not.toHaveBeenCalled();
	});
});
