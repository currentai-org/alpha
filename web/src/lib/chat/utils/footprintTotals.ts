import type { MessageFootprintUpdate } from "$lib/chat/types/MessageUpdate";
import { estimateEnergyBandWh, estimateEnergyWh } from "./energyEstimate";

/**
 * What a session has used, summed from per-answer figures. An answer is counted one of three ways:
 * from the server's EcoLogits figure (`server*`), as "not estimated" when the server priced it and
 * the model has no size on record (`unpricedTurns`), or, only where the server sent no figure at
 * all, from the text-length guess in energyEstimate (`fallbackTokens`).
 */
export interface FootprintTotals {
	fallbackTokens: number;
	/** Answers priced by the server. */
	serverTurns: number;
	/** Answers the server reported as not estimated. */
	unpricedTurns: number;
	serverEnergyMinWh: number;
	serverEnergyMaxWh: number;
	serverWaterMinL: number;
	serverWaterMaxL: number;
}

export const emptyTotals: FootprintTotals = {
	fallbackTokens: 0,
	serverTurns: 0,
	unpricedTurns: 0,
	serverEnergyMinWh: 0,
	serverEnergyMaxWh: 0,
	serverWaterMinL: 0,
	serverWaterMaxL: 0,
};

export interface Range {
	min: number;
	max: number;
}

/** An answer landed and the server has said nothing about it (yet): count its text-length guess. */
export function addFallbackTurn(t: FootprintTotals, tokens: number): FootprintTotals {
	return tokens > 0 ? { ...t, fallbackTokens: t.fallbackTokens + tokens } : t;
}

/**
 * The server's figure for an answer arrives after the answer. It replaces the guess made for that
 * answer (`pendingFallbackTokens`), so one answer is never counted twice. A turn the server could not
 * price is dropped from the figures rather than priced at the old flat rate.
 */
export function applyServerFigure(
	t: FootprintTotals,
	update: Pick<MessageFootprintUpdate, "estimated" | "energyWh" | "waterL">,
	pendingFallbackTokens: number
): FootprintTotals {
	const fallbackTokens = Math.max(0, t.fallbackTokens - Math.max(0, pendingFallbackTokens));
	if (!update.estimated || !update.energyWh) {
		return { ...t, fallbackTokens, unpricedTurns: t.unpricedTurns + 1 };
	}
	return {
		...t,
		fallbackTokens,
		serverTurns: t.serverTurns + 1,
		serverEnergyMinWh: t.serverEnergyMinWh + update.energyWh.min,
		serverEnergyMaxWh: t.serverEnergyMaxWh + update.energyWh.max,
		serverWaterMinL: t.serverWaterMinL + (update.waterL?.min ?? 0),
		serverWaterMaxL: t.serverWaterMaxL + (update.waterL?.max ?? 0),
	};
}

/** Whether any answer has contributed an energy figure. */
export function hasEnergy(t: FootprintTotals): boolean {
	return t.serverTurns > 0 || t.fallbackTokens > 0;
}

/** Session energy as a range in Wh: server ranges plus the guess's own plausibility band. */
export function energyRangeWh(t: FootprintTotals): Range {
	const guess = estimateEnergyBandWh(t.fallbackTokens);
	return { min: t.serverEnergyMinWh + guess.lo, max: t.serverEnergyMaxWh + guess.hi };
}

/** Headline session energy in Wh: the server figures' midpoints plus the guess's central figure. */
export function energyHeadlineWh(t: FootprintTotals): number {
	return (
		(t.serverEnergyMinWh + t.serverEnergyMaxWh) / 2 + estimateEnergyWh(t.fallbackTokens)
	);
}

/**
 * Session water in litres, or null when no answer has a server figure: the text-length guess has no
 * water in it, and a zero would read as "none used".
 */
export function waterRangeL(t: FootprintTotals): Range | null {
	if (t.serverTurns === 0) return null;
	return { min: t.serverWaterMinL, max: t.serverWaterMaxL };
}

/** Litres as a short string, in millilitres below one litre: "12 mL", "1.4 L". */
export function formatWater(litres: number): string {
	if (litres <= 0) return "0 mL";
	const ml = litres * 1000;
	if (ml < 1) return "<1 mL";
	if (ml < 1000) return `${ml < 10 ? ml.toFixed(1) : Math.round(ml)} mL`;
	return `${litres.toFixed(1)} L`;
}
