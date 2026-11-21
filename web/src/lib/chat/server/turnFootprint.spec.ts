import { describe, expect, it } from "vitest";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { createFootprintMeter, turnFootprint } from "./turnFootprint";

const MEDIUM = "mistral-medium-2604";
const LARGE_4 = "mistral-large-2610";
const GLM = "zai-org/GLM-5.2";
const APERTUS_70B = "swiss-ai/apertus-v1.5-70b";
const APERTUS_8B = "swiss-ai/apertus-v1.5-8b";

describe("turnFootprint", () => {
	it("prices a registry model as a positive energy range and a positive water range", () => {
		const f = turnFootprint({ modelId: MEDIUM, outputTokens: 500, latencySeconds: 10 });
		expect(f.type).toBe(MessageUpdateType.Footprint);
		expect(f.estimated).toBe(true);
		expect(f.energyWh && f.energyWh.min).toBeGreaterThan(0);
		expect(f.energyWh!.max).toBeGreaterThanOrEqual(f.energyWh!.min);
		expect(f.waterL && f.waterL.min).toBeGreaterThan(0);
		expect(f.waterL!.max).toBeGreaterThanOrEqual(f.waterL!.min);
	});

	it("reports Mistral Large 4 as not estimated with null figures, never a stand-in number", () => {
		const f = turnFootprint({ modelId: LARGE_4, outputTokens: 500, latencySeconds: 10 });
		expect(f.estimated).toBe(false);
		expect(f.energyWh).toBeNull();
		expect(f.waterL).toBeNull();
	});

	it("reports a model the catalog does not know as not estimated", () => {
		const f = turnFootprint({ modelId: "no-such/model-1b", outputTokens: 500, latencySeconds: 10 });
		expect(f.estimated).toBe(false);
		expect(f.energyWh).toBeNull();
	});

	it("reports a turn with no output tokens as not estimated rather than zero energy", () => {
		const f = turnFootprint({ modelId: MEDIUM, outputTokens: 0, latencySeconds: 1 });
		expect(f.estimated).toBe(false);
		expect(f.waterL).toBeNull();
	});

	it("prices an open model the registry lacks from the catalog's parameter count, with water", () => {
		const f = turnFootprint({ modelId: APERTUS_70B, outputTokens: 500, latencySeconds: 10 });
		expect(f.estimated).toBe(true);
		expect(f.energyWh!.min).toBeGreaterThan(0);
		expect(f.waterL!.min).toBeGreaterThan(0);
	});

	it("gives a 70B model more energy than an 8B model for the same turn", () => {
		const big = turnFootprint({ modelId: APERTUS_70B, outputTokens: 500, latencySeconds: 10 });
		const small = turnFootprint({ modelId: APERTUS_8B, outputTokens: 500, latencySeconds: 10 });
		expect(big.energyWh!.max).toBeGreaterThan(small.energyWh!.max);
	});

	it("prices a registry model served by a host other than the registry's provider, using its parameters", () => {
		const f = turnFootprint({ modelId: GLM, outputTokens: 500, latencySeconds: 10 });
		expect(f.estimated).toBe(true);
		expect(f.energyWh!.max).toBeGreaterThan(0);
	});

	it("gives a longer answer more energy than a shorter one on the same model", () => {
		const short = turnFootprint({ modelId: MEDIUM, outputTokens: 100, latencySeconds: 2 });
		const long = turnFootprint({ modelId: MEDIUM, outputTokens: 1000, latencySeconds: 20 });
		expect(long.energyWh!.max).toBeGreaterThan(short.energyWh!.max);
	});

	it("does not fail on a zero latency", () => {
		const f = turnFootprint({ modelId: MEDIUM, outputTokens: 50, latencySeconds: 0 });
		expect(f.estimated).toBe(true);
	});
});

describe("createFootprintMeter", () => {
	const seen: { modelId: string; outputTokens: number; latencySeconds: number }[] = [];
	const price = ((inputs: (typeof seen)[number]) => {
		seen.push(inputs);
		return turnFootprint(inputs);
	}) as typeof turnFootprint;
	const clock = (...times: number[]) => {
		const queue = [...times];
		return () => queue.shift() ?? 0;
	};

	it("sends no update for a turn that reported no usage, so the page keeps its own estimate", () => {
		const meter = createFootprintMeter(MEDIUM, clock(0, 1000), price);
		expect(meter.finish()).toEqual([]);
	});

	it("sends no update for a turn whose usage reported zero tokens", () => {
		const meter = createFootprintMeter(MEDIUM, clock(0, 1000), price);
		meter.noteUsage(0);
		expect(meter.finish()).toEqual([]);
	});

	it("counts a turn once when its host reports usage twice, using the larger count", () => {
		seen.length = 0;
		const meter = createFootprintMeter(MEDIUM, clock(0, 1000), price);
		meter.noteUsage(480);
		meter.noteUsage(120);
		meter.noteUsage(undefined);
		expect(meter.finish()).toHaveLength(1);
		expect(seen.at(-1)?.outputTokens).toBe(480);
	});

	it("prices the model that served the turn, and keeps it when a later chunk names none", () => {
		seen.length = 0;
		const meter = createFootprintMeter(MEDIUM, clock(0, 1000), price);
		meter.noteServedModel(APERTUS_70B);
		meter.noteServedModel(undefined);
		meter.noteServedModel("");
		meter.noteUsage(100);
		meter.finish();
		expect(seen.at(-1)?.modelId).toBe(APERTUS_70B);
	});

	it("prices the picked model when no chunk named the served one", () => {
		seen.length = 0;
		const meter = createFootprintMeter(MEDIUM, clock(0, 1000), price);
		meter.noteUsage(100);
		meter.finish();
		expect(seen.at(-1)?.modelId).toBe(MEDIUM);
	});

	it("measures latency in seconds from creation to finish", () => {
		seen.length = 0;
		const meter = createFootprintMeter(MEDIUM, clock(2000, 9500), price);
		meter.noteUsage(100);
		meter.finish();
		expect(seen.at(-1)?.latencySeconds).toBe(7.5);
	});

	it("returns no update, rather than throwing, when the estimate fails", () => {
		const meter = createFootprintMeter(
			MEDIUM,
			clock(0, 1000),
			(() => {
				throw new Error("boom");
			}) as typeof turnFootprint
		);
		meter.noteUsage(100);
		expect(meter.finish()).toEqual([]);
	});
});
