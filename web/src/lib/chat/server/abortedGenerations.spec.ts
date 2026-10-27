import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The poll's only DB call: collections.abortedGenerations.find({}).sort({createdAt:1}).toArray().
// Count toArray calls to assert WHEN the poll runs.
const toArray = vi.fn<
	() => Promise<
		Array<{ conversationId: { toString(): string }; createdAt: Date; updatedAt?: Date }>
	>
>(async () => []);

vi.mock("$lib/chat/server/database", () => ({
	collections: {
		abortedGenerations: { find: () => ({ sort: () => ({ toArray }) }) },
	},
}));
vi.mock("./exitHandler", () => ({ onExit: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { AbortedGenerations } from "./abortedGenerations";

describe("AbortedGenerations — demand-gated cross-instance poll", () => {
	let inst: AbortedGenerations;

	beforeEach(() => {
		vi.useFakeTimers();
		inst = AbortedGenerations.getInstance();
		inst._resetForTest();
		toArray.mockClear();
		toArray.mockImplementation(async () => []);
	});

	afterEach(() => {
		inst._resetForTest(); // leave the singleton idle (no dangling interval) for the next test
		vi.useRealTimers();
	});

	it("does NOT poll while idle (the bug fix: no free-running query on an idle instance)", async () => {
		await vi.advanceTimersByTimeAsync(5000);
		expect(toArray).not.toHaveBeenCalled();
	});

	it("polls immediately when a generation starts, then once per second while active", async () => {
		inst.beginGeneration();
		await vi.advanceTimersByTimeAsync(0); // flush the immediate poll
		expect(toArray).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(toArray).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(toArray).toHaveBeenCalledTimes(4);
	});

	it("keeps polling until the LAST concurrent generation ends, then stops (refcount)", async () => {
		inst.beginGeneration(); // 0→1: starts interval + immediate poll
		inst.beginGeneration(); // 1→2: interval already running, no extra immediate poll
		await vi.advanceTimersByTimeAsync(0);
		expect(toArray).toHaveBeenCalledTimes(1);

		inst.endGeneration(); // 2→1: still active, still polling
		await vi.advanceTimersByTimeAsync(1000);
		expect(toArray).toHaveBeenCalledTimes(2);

		inst.endGeneration(); // 1→0: stop
		await vi.advanceTimersByTimeAsync(5000);
		expect(toArray).toHaveBeenCalledTimes(2); // no polls after going idle
	});

	it("never drops below idle on an extra endGeneration (no negative count)", async () => {
		inst.endGeneration(); // count clamps at 0, no interval started
		await vi.advanceTimersByTimeAsync(2000);
		expect(toArray).not.toHaveBeenCalled();
		// a subsequent real generation still polls normally
		inst.beginGeneration();
		await vi.advanceTimersByTimeAsync(0);
		expect(toArray).toHaveBeenCalledTimes(1);
	});

	it("exposes polled abort times via getAbortTime; unknown ids are undefined (safe default)", async () => {
		const when = new Date("2026-06-28T00:00:00.000Z");
		toArray.mockImplementationOnce(async () => [
			{ conversationId: { toString: () => "conv-1" }, createdAt: when },
		]);
		inst.beginGeneration();
		await vi.advanceTimersByTimeAsync(0);
		expect(inst.getAbortTime("conv-1")).toEqual(when);
		expect(inst.getAbortTime("conv-unknown")).toBeUndefined();
	});

	it("survives a poll failure (warns, keeps the safe default) and recovers next tick", async () => {
		toArray.mockImplementationOnce(async () => {
			throw new Error("write CONNECTION_CLOSED ...-pooler.neon.tech:5432");
		});
		inst.beginGeneration();
		await vi.advanceTimersByTimeAsync(0); // failing immediate poll — must not throw
		expect(inst.getAbortTime("anything")).toBeUndefined();
		// next tick succeeds and populates
		const when = new Date("2026-06-28T01:00:00.000Z");
		toArray.mockImplementationOnce(async () => [
			{ conversationId: { toString: () => "conv-2" }, createdAt: when },
		]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(inst.getAbortTime("conv-2")).toEqual(when);
	});
});
