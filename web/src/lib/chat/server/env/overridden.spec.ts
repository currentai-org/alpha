import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above module-level consts, so the spy is created INSIDE the factory and retrieved
// afterwards — referencing an outer const here throws "cannot access before initialization".
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
const { logger } = (await import("$lib/chat/server/logger")) as unknown as {
	logger: { warn: ReturnType<typeof vi.fn> };
};
const warn = logger.warn;

import { noteOverridden, _resetOverrideLog } from "./overridden";

beforeEach(() => {
	warn.mockClear();
	_resetOverrideLog();
});

describe("noteOverridden", () => {
	// THE contract. This whole module is worthless if it chatters: firstKey already warns on every
	// designed fallback and is unreadable for exactly that reason (CUR-60). Silence
	// when nothing is overridden is what makes the line meaningful when it does appear.
	it("says NOTHING when the losing key is unset — an unshadowed decision is not news", () => {
		noteOverridden("rerank.transport", "tei", "RERANK_ENDPOINT_URL", [["RERANK_KIND", undefined]]);
		noteOverridden("x.y", "v", "WINNER", [["LOSER", ""]]);
		noteOverridden("x.z", "v", "WINNER", [["LOSER", "   "]]); // whitespace is unset
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns when a set key is ignored, naming the decision, the winner and the losers", () => {
		noteOverridden("rerank.transport", "tei", "RERANK_ENDPOINT_URL", [["RERANK_KIND", "hf"]]);
		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, message] = warn.mock.calls[0];
		expect(fields.decision).toBe("rerank.transport");
		expect(fields.value).toBe("tei");
		expect(fields.winner).toBe("RERANK_ENDPOINT_URL");
		expect(fields.ignored).toEqual(["RERANK_KIND"]);
		// The message must be greppable and self-explanatory in a log search, not just structured.
		expect(message).toContain("RERANK_KIND");
		expect(message).toContain("IGNORED");
	});

	it("reports only the losers that were actually set", () => {
		noteOverridden("d", "v", "W", [
			["SET_ONE", "yes"],
			["UNSET", ""],
			["SET_TWO", "also"],
		]);
		expect(warn.mock.calls[0][0].ignored).toEqual(["SET_ONE", "SET_TWO"]);
	});

	// These are cold-start facts. Logging them per request would recreate the noise problem the module
	// exists to avoid, and on a hot instance that is every turn.
	it("announces a given decision at most ONCE per process", () => {
		for (let i = 0; i < 5; i++) {
			noteOverridden("rerank.transport", "tei", "RERANK_ENDPOINT_URL", [["RERANK_KIND", "hf"]]);
		}
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("tracks decisions independently — one announcement does not mute another", () => {
		noteOverridden("a", "v", "W", [["L", "set"]]);
		noteOverridden("b", "v", "W", [["L", "set"]]);
		expect(warn).toHaveBeenCalledTimes(2);
	});
});
