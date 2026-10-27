import { describe, it, expect, vi } from "vitest";

// Hermetic gate: stub $lib/chat/server/models so importing ./worldModel (→ generateFromDefaultEndpoint
// → models) doesn't trigger models.ts's import-time buildModels() live fetch. The functions under
// test are pure; models/taskModel are only used on the live generation path.
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));

import {
	WORLD_MODEL_PREPASS,
	occludeDistance,
	parseReframe2,
	reframe2Gate,
	injectWorldModelNote,
	WORLD_MODEL_NOTE,
} from "./worldModel";

describe("world-model pre-pass — flag", () => {
	it("defaults OFF when WORLD_MODEL_PREPASS is unset (fail-safe to no behaviour change)", () => {
		expect(WORLD_MODEL_PREPASS).toBe(false);
	});
});

describe("occludeDistance", () => {
	it("strips the distance cue that hooks the heuristic", () => {
		// Faithful to the validated harness regex (evals/pragmatics): the trailing
		// "away|down the road|from the house" group is a single alternation, so
		// "100m away from my house" → "nearby from my house" (the residual is
		// harmless — extraction keys don't depend on it).
		expect(occludeDistance("The car wash is 100m away. Walk or drive?")).toBe(
			"The car wash is nearby. Walk or drive?"
		);
		expect(occludeDistance("station 0.5 km down the road")).toBe("station nearby");
		expect(occludeDistance("200 metres from the house")).toBe("nearby");
	});
	it("leaves non-distance text untouched", () => {
		expect(occludeDistance("Should I walk or drive to wash the car?")).toBe(
			"Should I walk or drive to wash the car?"
		);
	});
});

describe("parseReframe2", () => {
	it("parses a clean JSON object", () => {
		expect(parseReframe2('{"services_a_vehicle":"yes","moves_heavy_load":"no"}')).toEqual({
			services_a_vehicle: "yes",
			moves_heavy_load: "no",
		});
	});
	it("extracts the JSON block from surrounding prose / fences", () => {
		const raw = 'Here is the JSON:\n```\n{"services_a_vehicle":"no","moves_heavy_load":"yes"}\n```';
		expect(parseReframe2(raw)).toEqual({ services_a_vehicle: "no", moves_heavy_load: "yes" });
	});
	it("tolerates trailing commas and single quotes", () => {
		expect(parseReframe2("{'services_a_vehicle':'yes','moves_heavy_load':'no',}")).toEqual({
			services_a_vehicle: "yes",
			moves_heavy_load: "no",
		});
	});
	it("returns null on unparseable output (caller fails open → no spurious note)", () => {
		expect(parseReframe2("no idea, sorry")).toBeNull();
		expect(parseReframe2(undefined)).toBeNull();
		expect(parseReframe2("")).toBeNull();
	});
});

describe("reframe2Gate — the deterministic judge", () => {
	it("fires when the trip services a vehicle (the car-wash class)", () => {
		expect(reframe2Gate({ services_a_vehicle: "yes", moves_heavy_load: "no" })).toBe(true);
	});
	it("fires when a heavy load must be moved", () => {
		expect(reframe2Gate({ services_a_vehicle: "no", moves_heavy_load: "yes" })).toBe(true);
	});
	it("does NOT fire on a plain errand (walk-control → zero false-flip)", () => {
		expect(reframe2Gate({ services_a_vehicle: "no", moves_heavy_load: "no" })).toBe(false);
	});
	it("is case/whitespace tolerant on the yes-prefix", () => {
		expect(reframe2Gate({ services_a_vehicle: " Yes ", moves_heavy_load: "no" })).toBe(true);
		expect(reframe2Gate({ services_a_vehicle: "No", moves_heavy_load: "No" })).toBe(false);
	});
	it("fails closed (no fire) on null / missing keys", () => {
		expect(reframe2Gate(null)).toBe(false);
		expect(reframe2Gate({})).toBe(false);
	});
});

describe("injectWorldModelNote", () => {
	it("appends the note after the existing system prompt", () => {
		expect(injectWorldModelNote("PERSONA", WORLD_MODEL_NOTE)).toBe(
			`PERSONA\n\n${WORLD_MODEL_NOTE}`
		);
	});
	it("returns the note alone when there is no preprompt", () => {
		expect(injectWorldModelNote(undefined, WORLD_MODEL_NOTE)).toBe(WORLD_MODEL_NOTE);
		expect(injectWorldModelNote("  ", WORLD_MODEL_NOTE)).toBe(WORLD_MODEL_NOTE);
	});
});
