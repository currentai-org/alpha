import { describe, it, expect } from "vitest";
import { localizedBulbShort, localizedComparison, localizedElapsed } from "./energyCopy";

// Outside a request the interface language is English, so these read the English catalog.
describe("localizedComparison", () => {
	it("uses seconds of an LED bulb for tiny amounts", () => {
		expect(localizedComparison(0.001)).toMatch(/sec of a 10-watt LED bulb/);
	});

	it("uses minutes for a typical session", () => {
		expect(localizedComparison(1)).toMatch(/min of a 10-watt LED bulb/);
	});

	it("never claims zero seconds", () => {
		expect(localizedComparison(0)).toMatch(/about 1 sec/);
	});
});

describe("localizedElapsed", () => {
	it("collapses sub-minute to a calm phrase (no ticking seconds)", () => {
		expect(localizedElapsed(5_000)).toBe("under a minute");
	});

	it("shows whole minutes", () => {
		expect(localizedElapsed(4 * 60_000)).toBe("4 min");
	});

	it("shows hours and minutes past an hour", () => {
		expect(localizedElapsed(75 * 60_000)).toBe("1 hr 15 min");
	});

	it("omits minutes at an exact hour", () => {
		expect(localizedElapsed(120 * 60_000)).toBe("2 hr");
	});
});

// The short form the footprint trigger shows for a few seconds after each reply. (CUR-4266)
describe("localizedBulbShort", () => {
	it("names one reply's energy as seconds of an LED bulb, never zero", () => {
		expect(localizedBulbShort(0.001)).toBe("an LED bulb for 1 s");
		expect(localizedBulbShort(0)).toBe("an LED bulb for 1 s");
	});

	it("moves to minutes past 90 seconds", () => {
		expect(localizedBulbShort(1)).toBe("an LED bulb for 6 min");
	});
});
