import { describe, expect, it } from "vitest";
import { estimateEnergyWh } from "./energyEstimate";
import {
	addFallbackTurn,
	applyServerFigure,
	emptyTotals,
	energyHeadlineWh,
	energyRangeWh,
	formatWater,
	hasEnergy,
	waterRangeL,
} from "./footprintTotals";

const priced = {
	estimated: true,
	energyWh: { min: 0.2, max: 0.4 },
	waterL: { min: 0.001, max: 0.003 },
};
const unpriced = { estimated: false, energyWh: null, waterL: null };

describe("footprint totals", () => {
	it("counts an answer once: the server figure replaces that answer's text-length guess", () => {
		let t = addFallbackTurn(emptyTotals, 500);
		t = applyServerFigure(t, priced, 500);
		expect(t.fallbackTokens).toBe(0);
		expect(t.serverTurns).toBe(1);
		expect(energyHeadlineWh(t)).toBeCloseTo(0.3, 10);
	});

	it("keeps the text-length guess for an answer the server sent no figure for", () => {
		const t = addFallbackTurn(emptyTotals, 500);
		expect(energyHeadlineWh(t)).toBeCloseTo(estimateEnergyWh(500), 10);
		expect(waterRangeL(t)).toBeNull();
	});

	it("drops an unpriced answer's guess and counts it as not estimated, never at the old flat rate", () => {
		let t = addFallbackTurn(emptyTotals, 500);
		t = applyServerFigure(t, unpriced, 500);
		expect(t.fallbackTokens).toBe(0);
		expect(t.unpricedTurns).toBe(1);
		expect(hasEnergy(t)).toBe(false);
		expect(energyHeadlineWh(t)).toBe(0);
	});

	it("only replaces the latest answer's guess, leaving earlier guessed answers alone", () => {
		let t = addFallbackTurn(emptyTotals, 300);
		t = addFallbackTurn(t, 500);
		t = applyServerFigure(t, priced, 500);
		expect(t.fallbackTokens).toBe(300);
		expect(t.serverTurns).toBe(1);
	});

	it("sums server ranges across answers and gives water only when a server figure exists", () => {
		let t = applyServerFigure(emptyTotals, priced, 0);
		t = applyServerFigure(t, priced, 0);
		expect(energyRangeWh(t).min).toBeCloseTo(0.4, 10);
		expect(energyRangeWh(t).max).toBeCloseTo(0.8, 10);
		expect(waterRangeL(t)).toEqual({ min: 0.002, max: 0.006 });
	});

	it("never reports negative guessed tokens when a figure arrives with no pending guess", () => {
		const t = applyServerFigure(emptyTotals, priced, 999);
		expect(t.fallbackTokens).toBe(0);
	});
});

describe("formatWater", () => {
	it("uses millilitres below a litre and litres above", () => {
		expect(formatWater(0.0018)).toBe("1.8 mL");
		expect(formatWater(0.12)).toBe("120 mL");
		expect(formatWater(1.44)).toBe("1.4 L");
		expect(formatWater(0)).toBe("0 mL");
	});
});
