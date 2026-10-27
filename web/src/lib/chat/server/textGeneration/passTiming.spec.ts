import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const { logger } = await import("$lib/chat/server/logger");
const { timedPass, noteLongAnswer, SLOW_PASS_MS, LONG_ANSWER_CHARS } = await import("./passTiming");

/** A clock that reads `start`, then `start + ms`. */
const clock = (ms: number) => {
	const reads = [1_000, 1_000 + ms];
	return () => reads.shift() ?? 1_000 + ms;
};

beforeEach(() => vi.clearAllMocks());

describe("timedPass (CUR-3749)", () => {
	it("names a pass that blocked for SLOW_PASS_MS or longer, with its time and the answer's length", () => {
		const result = timedPass("stripEchoedWrapperTail", "x".repeat(40_000), () => "trimmed", clock(SLOW_PASS_MS + 250));
		expect(result).toBe("trimmed");
		expect(logger.warn).toHaveBeenCalledWith(
			{ pass: "stripEchoedWrapperTail", ms: SLOW_PASS_MS + 250, chars: 40_000 },
			"[honesty] slow pass over the answer"
		);
	});

	it("stays silent for a pass under SLOW_PASS_MS, and still returns its result", () => {
		expect(timedPass("measureDegeneration", "short", () => 7, clock(SLOW_PASS_MS - 1))).toBe(7);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("lets a pass's throw through and logs nothing for it", () => {
		expect(() =>
			timedPass("detectFabricatedSources", "text", () => {
				throw new Error("boom");
			}, clock(SLOW_PASS_MS * 2))
		).toThrow("boom");
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("noteLongAnswer (CUR-3749)", () => {
	it("logs an answer of LONG_ANSWER_CHARS or more before its passes, so a killed request still leaves its size", () => {
		noteLongAnswer("y".repeat(LONG_ANSWER_CHARS));
		expect(logger.info).toHaveBeenCalledWith(
			{ chars: LONG_ANSWER_CHARS },
			"[honesty] end-of-stream passes starting on a long answer"
		);
	});

	it("says nothing about a shorter answer", () => {
		noteLongAnswer("y".repeat(LONG_ANSWER_CHARS - 1));
		expect(logger.info).not.toHaveBeenCalled();
	});
});
