// The harness decision. The plan depends on the model's row alone: never on
// the environment, the person or a flag, so www serves a model the turn develop serves it. (CUR-2420, CUR-2697, CUR-4015)
import { describe, it, expect, vi, beforeEach } from "vitest";

// The environment and PostHog are mocked so the contract can vary them and show the plan does not move.
// The selector reads neither; a change that brings either back is what these mocks are here to catch.
let env: string | null = "preview";
let flagAnswer: boolean | undefined = true;
let override: boolean | undefined;
vi.mock("$lib/chat/server/deployEnv", () => ({ deployEnv: () => env }));
vi.mock("$lib/chat/server/flags", () => ({
	ensureFlagsPolled: async () => {},
	flagEnabledForUser: async () => flagAnswer,
	fuzzOverrideValue: () => override,
}));

const { resolveHarness, harnessForTurn, planFromTricks } = await import("./harness");
const { ALL_TRICKS, tricksFor, asksCalculateCounts } = await import("./harnessProfiles");
const { runWithRequestContext, getRequestContext } = await import("./requestContext");

const SCAFFOLDED = {
	kind: "scaffolded",
	prompt: "persona",
	retrieval: "pipeline",
	mathRouting: true,
	streamGuards: true,
	decoding: "grounded",
};
const NATIVE = {
	kind: "native",
	prompt: "minimal",
	retrieval: "tools",
	mathRouting: false,
	streamGuards: true,
	decoding: "model",
};
const native = { id: "mistral-large-2512", supportsTools: true };
const apertus = { id: "swiss-ai/apertus-v1.5-70b", supportsTools: true };

beforeEach(() => {
	env = "preview";
	flagAnswer = true;
	override = undefined;
});

describe("the plan depends on the model's profile, never on the environment (CUR-4015)", () => {
	for (const model of [native, apertus, { id: "bsc-lt/alia-40b-instruct", supportsTools: true }]) {
		it(`${model.id} gets one plan in production, preview and development, whatever PostHog answers`, () => {
			const plans = [];
			for (const e of ["production", "preview", "development", null])
				for (const f of [true, false, undefined])
					for (const o of [true, false, undefined]) {
						env = e;
						flagAnswer = f;
						override = o;
						plans.push(harnessForTurn(model));
					}
			for (const plan of plans) expect(plan).toEqual(resolveHarness(model));
		});
	}
	it("Large 3 is on the native plan in production", () => {
		env = "production";
		expect(harnessForTurn(native)).toEqual(NATIVE);
	});
	it("Apertus keeps every trick in production and preview alike", () => {
		env = "production";
		expect(harnessForTurn(apertus)).toEqual(SCAFFOLDED);
		env = "preview";
		expect(harnessForTurn(apertus)).toEqual(SCAFFOLDED);
	});
});

describe("a model the native shape does not fit carries every trick", () => {
	it("Large 3 without tool support, since the native shape's retrieval is tools", () => {
		expect(resolveHarness({ ...native, supportsTools: false })).toEqual(SCAFFOLDED);
	});
	it("ALIA without tool support keeps its row's tricks, so the persona it dropped stays off (CUR-3898)", () => {
		const plan = resolveHarness({ id: "bsc-lt/alia-40b-instruct", supportsTools: false });
		expect(plan.prompt).toBe("minimal");
		expect(plan.retrieval).toBe("pipeline");
	});
	it("a model with no row, never the light turn", () => {
		expect(resolveHarness({ id: "acme/unvetted-7b", supportsTools: true })).toEqual(SCAFFOLDED);
		expect(resolveHarness({ supportsTools: true })).toEqual(SCAFFOLDED);
	});
});

describe("the rows reproduce the turn each model had before its tricks moved into them", () => {
	it("the Mistral rows and GLM 5.2, whose tricks lost a blind A/B, carry no trick", () => {
		for (const id of ["mistral-large-2512", "mistral-large-2610", "mistral-small-2603", "mistral-medium-2604", "zai-org/glm-5.2"])
			expect([id, [...tricksFor(id)]]).toEqual([id, []]);
	});
	it("every other offered row, served scaffolded until now, carries all four", () => {
		for (const id of [
			"swiss-ai/apertus-v1.5-70b",
			"swiss-ai/apertus-v1.5-70b-thinking",
			"swiss-ai/apertus-v1.5-8b",
			"swiss-ai/apertus-8b-instruct",
			"aisingapore/qwen-sea-lion-v4-32b-it",
			"aisingapore/gemma-sea-lion-v4-27b-it",
			"aisingapore/nemotron-sea-lion-v4.8-120b-a12b",
			"speakleash/bielik-11b-v3.0-instruct",
		])
			expect([id, [...tricksFor(id)].sort()]).toEqual([id, [...ALL_TRICKS].sort()]);
	});
	it("ALIA keeps every trick but the persona, which with grounded decoding made it recite its fenced turn (CUR-3835)", () => {
		expect([...tricksFor("bsc-lt/alia-40b-instruct")].sort()).toEqual(
			ALL_TRICKS.filter((t) => t !== "fewShotPersona").sort()
		);
	});
});

describe("native calculate asks for group counts only where a model was measured to need it (CUR-4015)", () => {
	it("Medium and Large 3 ask for them; an unlisted model does not (CUR-1202)", () => {
		expect(asksCalculateCounts("mistral-medium-2604")).toBe(true);
		expect(asksCalculateCounts("mistral-large-2512")).toBe(true);
		expect(asksCalculateCounts("acme/unvetted-7b")).toBe(false);
	});
});

describe("each trick turns on exactly one plan field", () => {
	const FIELD = {
		fewShotPersona: ["prompt", "persona"],
		preTurnRetrieval: ["retrieval", "pipeline"],
		mathPlanner: ["mathRouting", true],
		groundedDecoding: ["decoding", "grounded"],
	} as const;
	for (const trick of ALL_TRICKS) {
		it(`${trick} alone changes only ${FIELD[trick][0]} from the native plan`, () => {
			const base = planFromTricks(new Set());
			const one = planFromTricks(new Set([trick]));
			const changed = (Object.keys(base) as (keyof typeof base)[]).filter((k) => k !== "kind" && one[k] !== base[k]);
			expect(changed).toEqual([FIELD[trick][0]]);
			expect(one[FIELD[trick][0]]).toBe(FIELD[trick][1]);
		});
	}
	it("all four make the scaffolded plan", () => {
		expect(planFromTricks(new Set(ALL_TRICKS))).toEqual(SCAFFOLDED);
	});
});

describe("the layer test's dropTricks switch takes named tricks off one model's row (CUR-2697)", () => {
	const withDrop = <T>(drop: string[], fn: () => Promise<T>) =>
		runWithRequestContext(
			async () => ({ plan: await fn(), applied: getRequestContext()?.evalLayersApplied }),
			{ evalLayers: { dropTricks: drop } as never }
		);

	it("drops grounded decoding from Apertus and keeps its other three tricks, reporting the drop", async () => {
		const { plan, applied } = await withDrop(["groundedDecoding"], async () => harnessForTurn(apertus));
		expect(plan).toEqual({ ...SCAFFOLDED, decoding: "model" });
		expect(applied).toEqual({ dropTricks: ["groundedDecoding"] });
	});
	it("dropping every trick gives the native turn", async () => {
		const { plan } = await withDrop([...ALL_TRICKS], async () => harnessForTurn(apertus));
		expect(plan.kind).toBe("native");
	});
	it("keeps pre-turn retrieval on a model without tools and reports it as not dropped", async () => {
		const noTools = { ...apertus, supportsTools: false };
		const { plan, applied } = await withDrop(["preTurnRetrieval"], async () => harnessForTurn(noTools));
		expect(plan).toEqual(SCAFFOLDED);
		expect(applied).toEqual({ dropTricks: [] });
	});
	it("reports a trick the row never carried as not dropped", async () => {
		const { plan, applied } = await withDrop(["mathPlanner"], async () => harnessForTurn(native));
		expect(plan.kind).toBe("native");
		expect(applied).toEqual({ dropTricks: [] });
	});
});
