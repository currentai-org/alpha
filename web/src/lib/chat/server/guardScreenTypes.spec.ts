import { describe, it, expect } from "vitest";
import { capScreenHistory, SCREEN_HISTORY_CAP } from "./guardScreenTypes";

// under `guard-history-cap` the input screen reads the newest user message whole plus the
// end of the earlier ones, up to SCREEN_HISTORY_CAP in total. The newest is never cut.
describe("capScreenHistory", () => {
	it("keeps the newest message whole and fills the rest of the cap with the END of the earlier history", () => {
		const older = "a".repeat(3_000);
		const recent = "b".repeat(3_000);
		const newest = "c".repeat(1_000);
		const out = capScreenHistory([older, recent, newest]);

		expect(out.length).toBe(SCREEN_HISTORY_CAP);
		expect(out.endsWith(`\n\n${newest}`)).toBe(true);
		expect(`${older}\n\n${recent}\n\n${newest}`.endsWith(out)).toBe(true);
		expect(out).not.toContain("a");
	});

	it("returns the uncapped join, byte for byte, when the whole history fits under the cap", () => {
		const texts = ["first", "second", "third"];
		expect(capScreenHistory(texts)).toBe(texts.join("\n\n"));
	});

	it("screens a newest message of the cap or longer whole and alone, never cut and with no history", () => {
		const history = "h".repeat(500);
		const atCap = "n".repeat(SCREEN_HISTORY_CAP);
		const overCap = "n".repeat(SCREEN_HISTORY_CAP * 3);
		expect(capScreenHistory([history, atCap])).toBe(atCap);
		expect(capScreenHistory([history, overCap])).toBe(overCap);
	});

	it("returns the newest message alone when there is no history, and an empty string for no messages", () => {
		expect(capScreenHistory(["only"])).toBe("only");
		expect(capScreenHistory([])).toBe("");
	});

	it("adds no history when the separator alone would pass the cap", () => {
		expect(capScreenHistory(["hist", "n".repeat(8)], 10)).toBe("n".repeat(8));
		expect(capScreenHistory(["hist", "n".repeat(7)], 10)).toBe(`t\n\n${"n".repeat(7)}`);
	});
});
