import { describe, it, expect } from "vitest";
import {
	estimateTokensFromText,
	estimateEnergyWh,
	estimateEnergyBandWh,
	formatEnergy,
	formatEnergyShort,
	J_PER_OUTPUT_TOKEN,
	J_PER_OUTPUT_TOKEN_LO,
	J_PER_OUTPUT_TOKEN_HI,
	IDLE_AMORTIZATION,
	PUE,
} from "./energyEstimate";

describe("estimateTokensFromText", () => {
	it("returns 0 for empty text", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("estimates ~1 token per 4 chars", () => {
		expect(estimateTokensFromText("a".repeat(400))).toBe(100);
	});
});

describe("estimateEnergyWh", () => {
	it("is 0 for 0 tokens", () => {
		expect(estimateEnergyWh(0)).toBe(0);
	});

	it("applies the full chain: tokens x J/token x (1+idle) x PUE / 3600", () => {
		const tokens = 1000;
		const expected = (tokens * J_PER_OUTPUT_TOKEN * (1 + IDLE_AMORTIZATION) * PUE) / 3600;
		expect(estimateEnergyWh(tokens)).toBeCloseTo(expected, 10);
	});

	it("scales linearly with tokens", () => {
		expect(estimateEnergyWh(2000)).toBeCloseTo(2 * estimateEnergyWh(1000), 10);
	});

	it("a chatty session (~1500 output tokens) lands in single-digit Wh", () => {
		const wh = estimateEnergyWh(1500);
		expect(wh).toBeGreaterThan(0);
		expect(wh).toBeLessThan(5);
	});
});

describe("estimateEnergyBandWh", () => {
	it("brackets the midpoint estimate", () => {
		const tokens = 1000;
		const mid = estimateEnergyWh(tokens);
		const { lo, hi } = estimateEnergyBandWh(tokens);
		expect(lo).toBeLessThan(mid);
		expect(hi).toBeGreaterThan(mid);
	});

	it("lo/hi track the per-token band constants", () => {
		const tokens = 1000;
		const { lo, hi } = estimateEnergyBandWh(tokens);
		const expectedLo = (tokens * J_PER_OUTPUT_TOKEN_LO * (1 + IDLE_AMORTIZATION) * PUE) / 3600;
		const expectedHi = (tokens * J_PER_OUTPUT_TOKEN_HI * (1 + IDLE_AMORTIZATION) * PUE) / 3600;
		expect(lo).toBeCloseTo(expectedLo, 10);
		expect(hi).toBeCloseTo(expectedHi, 10);
	});
});

describe("formatEnergy", () => {
	it("shows mWh below ~0.1 Wh", () => {
		expect(formatEnergy(0.05)).toBe("50 mWh");
	});

	it("shows 2 decimals between 0.1 and 1 Wh", () => {
		expect(formatEnergy(0.42)).toBe("0.42 Wh");
	});

	it("shows 1 decimal at/above 1 Wh", () => {
		expect(formatEnergy(2.345)).toBe("2.3 Wh");
	});
});

describe("formatEnergyShort", () => {
	it("shows 0Wh only when nothing has been spent", () => {
		expect(formatEnergyShort(0)).toBe("0Wh");
	});

	// A first reply is ~10 mWh, and one decimal of Wh printed it as "0.0Wh" right after the
	// bloom card said "~10 mWh", which reads as the counter resetting. (CUR-1694)
	it("never prints a nonzero figure as 0.0Wh: a ~10 mWh reply reads 10mWh", () => {
		expect(formatEnergyShort(0.01)).toBe("10mWh");
		expect(formatEnergyShort(0.0002)).toBe("1mWh");
		expect(formatEnergyShort(0.049)).not.toBe("0.0Wh");
	});

	it("keeps one decimal of Wh from 0.05 Wh, where it no longer rounds to zero", () => {
		expect(formatEnergyShort(0.05)).toBe("0.1Wh");
		expect(formatEnergyShort(0.3)).toBe("0.3Wh");
		expect(formatEnergyShort(12.4)).toBe("12Wh");
	});
});

describe("energyAnchor (session meter reference)", async () => {
	const { energyAnchor } = await import("./energyEstimate");
	it("anchors a typical session to a phone charge, not an arbitrary 500 Wh", () => {
		expect(energyAnchor(0.4)).toMatchObject({ wh: 15, short: "1 phone charge" });
	});
	it("steps up to the next everyday amount once usage exceeds the previous one", () => {
		expect(energyAnchor(20).short).toBe("1 laptop charge");
		expect(energyAnchor(80).short).toBe("1 kettle boil");
	});
	it("never returns a reference smaller than the usage (the bar can't overflow)", () => {
		for (const wh of [0, 1, 15, 15.1, 99, 100, 101, 350]) expect(energyAnchor(wh).wh).toBeGreaterThanOrEqual(wh);
	});
});

describe("energyBreakdown (methodology chart)", async () => {
	const { energyBreakdown, estimateEnergyWh } = await import("./energyEstimate");
	it("sums to 1 and agrees with the headline chain (compute share × total = compute-only energy)", () => {
		const b = energyBreakdown();
		expect(b.compute + b.idle + b.overhead).toBeCloseTo(1, 10);
		const total = estimateEnergyWh(1000);
		const computeOnlyWh = (1000 * 1.5) / 3600;
		expect(b.compute * total).toBeCloseTo(computeOnlyWh, 10);
	});
});
