/**
 * publishRegistry + applyLiveRegistry (TTFT plan §C). publishRegistry must update all FOUR live exports
 * together (models by in-place mutation; defaultModel/taskModel/validModelIdSchema reassigned) so a drift
 * refresh can never leave them disagreeing; applyLiveRegistry must republish + log ONLY on an id-set
 * drift and stand pat otherwise.
 *
 * Hermetic gate: mock $lib/chat/server/config so OPENAI_BASE_URL resolves EMPTY — models.ts's module-eval
 * boot then throws "OPENAI_BASE_URL not set", which its own .catch swallows, so importing the REAL
 * models.ts here does NOT hit the network and the registry starts empty for us to publish into directly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/config", () => {
	// Every key resolves to "" (unset) — including OPENAI_BASE_URL, so buildModels() throws at boot.
	const config = new Proxy(
		{ isHuggingChat: false },
		{ get: (target, prop) => (prop in target ? Reflect.get(target, prop) : "") }
	);
	return { config, ready: Promise.resolve() };
});

import { applyLiveRegistry, publishRegistry, models } from "./models";
import type { ProcessedModel } from "./models";
import { AGENT_MODEL_ID } from "./chat/resolveAgentRoute";
import { logger } from "./logger";
// The three reassigned exports are read via the live namespace binding (not a captured local) so the
// test observes the reassignment publishRegistry performs.
import * as modelsModule from "./models";

// A minimal ProcessedModel — publishRegistry only reads .id/.name (defaultModel=models[0],
// resolveTaskModel by name/id, createValidModelIdSchema by id).
const mk = (id: string): ProcessedModel => ({ id, name: id }) as ProcessedModel;

describe("publishRegistry", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("updates all four live exports consistently", () => {
		publishRegistry([mk("a/one"), mk("b/two")]);

		// models refreshed by in-place mutation (same array object identity)
		expect(models.map((m) => m.id)).toEqual(["a/one", "b/two"]);
		// the other three reassigned — read via the live module binding
		expect(modelsModule.defaultModel.id).toBe("a/one");
		expect(modelsModule.taskModel.id).toBe("a/one");
		expect(modelsModule.validModelIdSchema.safeParse("a/one").success).toBe(true);
		expect(modelsModule.validModelIdSchema.safeParse("b/two").success).toBe(true);
		expect(modelsModule.validModelIdSchema.safeParse("ghost").success).toBe(false);
	});

	it("in-place mutation keeps the models array reference stable across republishes", () => {
		const ref = models;
		publishRegistry([mk("x/1")]);
		expect(models).toBe(ref); // same object — an importer holding the array observes the update
		expect(ref.map((m) => m.id)).toEqual(["x/1"]);
	});

	// The agent's id is excluded from validModelIdSchema even when it IS a registered model —
	// it's never a directly-selectable id, only resolveAgentRoute can produce it on a live turn. This is
	// the one place that matters: every PATCH/settings/create endpoint validates through this (or, for a
	// per-user request, getEffectiveValidModelIdSchema — localModels.ts — which applies the identical
	// exclusion over the effective registry), so proving it here proves it everywhere real traffic goes. (CUR-770)
	it("validModelIdSchema rejects the agent id even when it's a registered model", () => {
		publishRegistry([mk("a/one"), mk(AGENT_MODEL_ID)]);

		expect(modelsModule.validModelIdSchema.safeParse("a/one").success).toBe(true);
		expect(modelsModule.validModelIdSchema.safeParse(AGENT_MODEL_ID).success).toBe(false);
	});

	// The task model, the compare panel and the backup lane are registered `unlisted` so the
	// server can call them. A visitor naming one in a PATCH must be refused, not chat on it from then on. (CUR-3517)
	it("validModelIdSchema refuses an unlisted side-call model a visitor names, and keeps accepting a listed one", () => {
		publishRegistry([mk("a/one"), { ...mk("side/task"), unlisted: true } as ProcessedModel]);

		expect(modelsModule.validModelIdSchema.safeParse("a/one").success).toBe(true);
		expect(modelsModule.validModelIdSchema.safeParse("side/task").success).toBe(false);
	});
});

describe("applyLiveRegistry", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// baseline registry the drift refresh compares against / republishes over
		publishRegistry([mk("a")]);
	});

	it("republishes the live registry and logs [models] snapshot drift on an id-set change", () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
		const republished = applyLiveRegistry([mk("a")], [mk("a"), mk("b")]);

		expect(republished).toBe(true);
		expect(models.map((m) => m.id)).toEqual(["a", "b"]);
		const driftLog = info.mock.calls.find((c) => String(c[1]).includes("snapshot drift"));
		expect(driftLog).toBeTruthy();
		expect(driftLog?.[0]).toMatchObject({ snapshotIds: ["a"], liveIds: ["a", "b"] });
	});

	it("does NOT republish or log when the id set is unchanged (snapshot stands)", () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
		const republished = applyLiveRegistry([mk("a")], [mk("a")]);

		expect(republished).toBe(false);
		expect(info.mock.calls.some((c) => String(c[1]).includes("snapshot drift"))).toBe(false);
	});

	it("keeps the snapshot when the background live build produced nothing", () => {
		const republished = applyLiveRegistry([mk("a")], []);
		expect(republished).toBe(false);
		expect(models.map((m) => m.id)).toEqual(["a"]); // unchanged
	});

	// CUR-1246, and the reason the `length === 0` guard above was not enough. buildModelsFromCatalog
	// appends the agent model and the compare panel AFTER the allowlisted chat models, so a build whose
	// allowlist matched NOTHING still returns several entries — all of them unlisted, none of them
	// something a visitor can send a message to. Counting the array instead of the servable models let
	// exactly this replace a working snapshot, which then serves "No models available" for the rest of
	// its life while every route answers 200.
	it("keeps the snapshot when the live build has only the agent and compare models", () => {
		const unlisted = (id: string): ProcessedModel => ({ id, name: id, unlisted: true }) as ProcessedModel;
		const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

		const republished = applyLiveRegistry(
			[mk("a")],
			[mk(AGENT_MODEL_ID), unlisted("compare/one"), unlisted("compare/two")]
		);

		expect(republished).toBe(false);
		expect(models.map((m) => m.id)).toEqual(["a"]); // the working snapshot still serves
		expect(info.mock.calls.some((c) => String(c[1]).includes("snapshot drift"))).toBe(false);
	});
});

// The task model serves every side call. It must not fall back to modelList[0] when TASK_MODEL
// is unset or matches nothing, or a typo or a reordered allowlist would move side calls silently. (CUR-2319)
describe("resolveTaskModel", () => {
	const list = [mk("first/model"), mk("named/task")];

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the model TASK_MODEL names", () => {
		expect(modelsModule.resolveTaskModel(list, "named/task", "production").id).toBe("named/task");
	});

	it("throws, naming both the setting and the registry, when TASK_MODEL matches no registered model", () => {
		expect(() => modelsModule.resolveTaskModel(list, "typo/model", "preview")).toThrow(
			/TASK_MODEL is "typo\/model".*first\/model, named\/task/
		);
	});

	it("throws on a TASK_MODEL that matches nothing even where no environment is declared", () => {
		expect(() => modelsModule.resolveTaskModel(list, "typo/model", null)).toThrow(/typo\/model/);
	});

	it.each(["production", "preview"] as const)(
		"throws when TASK_MODEL is unset on %s, instead of falling back to the first model",
		(env) => {
			expect(() => modelsModule.resolveTaskModel(list, "", env)).toThrow(
				new RegExp(`TASK_MODEL is unset on ${env}`)
			);
		}
	);

	it("falls back to the first model with a warning only where no deployed environment is declared (local dev, hermetic CI)", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		expect(modelsModule.resolveTaskModel(list, undefined, null).id).toBe("first/model");
		expect(warn.mock.calls[0]?.[0]).toMatchObject({ taskModelFallback: true, servedModel: "first/model" });
	});
});

describe("publishRegistry with a misconfigured TASK_MODEL", () => {
	it("leaves the previous registry serving, every export unchanged, when the task model cannot resolve", () => {
		publishRegistry([mk("keep/one")]);
		const saved = process.env.DEPLOY_ENV;
		process.env.DEPLOY_ENV = "preview";
		try {
			// The mocked config leaves TASK_MODEL unset, which a preview refuses.
			expect(() => publishRegistry([mk("new/one"), mk("new/two")])).toThrow(/TASK_MODEL is unset on preview/);
		} finally {
			if (saved === undefined) delete process.env.DEPLOY_ENV;
			else process.env.DEPLOY_ENV = saved;
		}
		expect(models.map((m) => m.id)).toEqual(["keep/one"]);
		expect(modelsModule.defaultModel.id).toBe("keep/one");
		expect(modelsModule.taskModel.id).toBe("keep/one");
		expect(modelsModule.validModelIdSchema.safeParse("new/one").success).toBe(false);
	});
});
