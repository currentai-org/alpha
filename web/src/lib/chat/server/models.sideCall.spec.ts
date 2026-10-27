/**
 * Side-call models register themselves (CUR-2261). ARITHMETIC_ROUTE_MODEL (the math-routing turn
 * planner) and TASK_MODEL (titles and other side calls) are looked up by id in the registry. Each
 * registers its own model, so it works whether or not COMPARE_PANEL lists the same id; otherwise math
 * routing would log "plan model is not registered" and plan nothing, and titles would fall back to the
 * default chat model.
 *
 * Idioms mirror models.boot.spec.ts: `config` is a Proxy over a mutable object, `$app/environment`
 * says `building: true` so the module-eval boot is skipped, and each test drives bootModels() against
 * a stubbed live catalog.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const BASE = "https://api.test/v1";
const COMPARE_BASE = "https://compare.test/v1";
const CHAT_MODEL = "test-org/chat-model";
const PANELIST = "test-org/panelist";
const PLANNER = "test-org/planner";
const TITLER = "test-org/titler";

const MISTRAL_BASE = "https://api.mistral.test/v1";
const MISTRAL_SMALL = "mistral-small-2603";
const MISTRAL_MEDIUM = "mistral-medium-2604";

const H = vi.hoisted(() => ({ cfg: {} as Record<string, string>, flagsOn: new Set<string>() }));

// Registry gates read PostHog through this module. Only the keys a test turns on answer true; every
// other read takes its fallback, which is what an unreachable PostHog does.
vi.mock("$lib/chat/server/flags", () => ({
	refreshFlags: async () => {},
	whenFlagsPolled: () => false,
	ensureFlagsPolled: async () => {},
	flagEnabledForUser: async () => false,
	flagEnabledOr: (key: string, fallback: () => boolean) => (H.flagsOn.has(key) ? true : fallback()),
}));

vi.mock("$lib/chat/server/config", () => {
	const config = new Proxy(H.cfg, {
		get: (target, prop) => (prop in target ? Reflect.get(target, prop) : ""),
	});
	return { config, ready: Promise.resolve() };
});

vi.mock("$app/environment", () => ({ building: true, dev: false, browser: false, version: "test" }));

// No committed snapshot, so bootModels() takes the live catalog path.
vi.mock("$lib/chat/server/data/models-snapshot.json", () => ({
	default: { fetchedAt: "", baseURL: "", entries: [] },
}));

vi.mock("$lib/chat/server/logger", () => {
	const noop = () => {};
	const logger: Record<string, unknown> = {
		info: noop,
		warn: noop,
		error: noop,
		debug: noop,
		trace: noop,
		fatal: noop,
		silent: noop,
	};
	logger.child = () => logger;
	return { logger };
});

beforeEach(() => {
	vi.resetModules();
	H.flagsOn.clear();
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, {
		OPENAI_BASE_URL: BASE,
		OPENAI_API_KEY: "test-key",
		MODEL_ALLOWLIST: CHAT_MODEL,
		SECOND_OPINION_BASE_URL: COMPARE_BASE,
		SECOND_OPINION_API_KEY: "compare-key",
		COMPARE_PANEL: PANELIST,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: [{ id: CHAT_MODEL }] }),
		}))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const boot = async () => {
	const mod = await import("./models");
	await mod.bootModels();
	return mod;
};

describe("side-call models register in their own right (CUR-2261)", () => {
	it("registers ARITHMETIC_ROUTE_MODEL as an unlisted model on the compare endpoint even when COMPARE_PANEL does not list it", async () => {
		H.cfg.ARITHMETIC_ROUTE_MODEL = PLANNER;
		const mod = await boot();

		const planner = mod.models.find((m) => m.id === PLANNER);
		expect(planner).toBeDefined();
		expect(planner?.unlisted).toBe(true);
		expect(JSON.stringify(planner?.endpoints)).toContain(COMPARE_BASE);
	});

	it("makes a TASK_MODEL that COMPARE_PANEL does not list the task model, instead of silently falling back to the default chat model", async () => {
		H.cfg.TASK_MODEL = TITLER;
		const mod = await boot();

		expect(mod.taskModel.id).toBe(TITLER);
		expect(mod.defaultModel.id).toBe(CHAT_MODEL);
	});

	it("leaves an id that is already registered alone: a TASK_MODEL naming the allowlisted chat model is not registered a second time", async () => {
		H.cfg.TASK_MODEL = CHAT_MODEL;
		H.cfg.ARITHMETIC_ROUTE_MODEL = PANELIST;
		const mod = await boot();

		expect(mod.models.filter((m) => m.id === CHAT_MODEL)).toHaveLength(1);
		expect(mod.models.filter((m) => m.id === PANELIST)).toHaveLength(1);
		expect(mod.models.find((m) => m.id === CHAT_MODEL)?.unlisted).toBe(false);
	});

	it("registers nothing extra when the side-call vars are unset", async () => {
		const mod = await boot();

		expect(mod.models.map((m) => m.id).sort()).toEqual([CHAT_MODEL, PANELIST].sort());
	});
});

describe("the entity-scope guard's model registers even when COMPARE_PANEL omits it (CUR-2263)", () => {
	// rag/entityScopeGuard.ts pins to SECOND_OPINION_MODEL only when models.some(m => m.id === id),
	// so registration is exactly the condition the pin depends on.
	it("registers a SECOND_OPINION_MODEL that COMPARE_PANEL does not list, so the guard pins to it instead of the default endpoint", async () => {
		const GUARD = "test-org/guard";
		H.cfg.SECOND_OPINION_MODEL = GUARD;
		const mod = await boot();

		const guard = mod.models.find((m) => m.id === GUARD);
		expect(guard).toBeDefined();
		expect(guard?.unlisted).toBe(true);
		expect(JSON.stringify(guard?.endpoints)).toContain(COMPARE_BASE);
	});
});

describe("a side-call model that Mistral serves registers on the Mistral lane (CUR-2262)", () => {
	// Side calls moving to mistral-small-2603: registered on the compare endpoint, that id would be
	// sent to the second-opinion provider, which does not serve it.
	beforeEach(() => {
		Object.assign(H.cfg, {
			MISTRAL_BASE_URL: MISTRAL_BASE,
			MISTRAL_API_KEY: "mistral-key",
			MISTRAL_MODELS: MISTRAL_SMALL,
			TASK_MODEL: MISTRAL_SMALL,
			ARITHMETIC_ROUTE_MODEL: MISTRAL_SMALL,
		});
	});

	it("with side-call-own-lane on, sends a TASK_MODEL listed in MISTRAL_MODELS to the Mistral base URL, not the compare endpoint", async () => {
		H.flagsOn.add("side-call-own-lane");
		const mod = await boot();

		const small = mod.models.filter((m) => m.id === MISTRAL_SMALL);
		expect(small).toHaveLength(1);
		expect(small[0]?.unlisted).toBe(true);
		expect(JSON.stringify(small[0]?.endpoints)).toContain(MISTRAL_BASE);
		expect(JSON.stringify(small[0]?.endpoints)).not.toContain(COMPARE_BASE);
		expect(mod.taskModel.id).toBe(MISTRAL_SMALL);
	});

	it("with side-call-own-lane on, registers the Mistral side-call model even when no compare endpoint is configured", async () => {
		H.flagsOn.add("side-call-own-lane");
		delete H.cfg.SECOND_OPINION_BASE_URL;
		delete H.cfg.SECOND_OPINION_API_KEY;
		const mod = await boot();

		const small = mod.models.find((m) => m.id === MISTRAL_SMALL);
		expect(JSON.stringify(small?.endpoints)).toContain(MISTRAL_BASE);
	});

	it("with the flag off, keeps today's registration on the compare endpoint (flag-off is the unchanged path)", async () => {
		const mod = await boot();

		const small = mod.models.find((m) => m.id === MISTRAL_SMALL);
		expect(JSON.stringify(small?.endpoints)).toContain(COMPARE_BASE);
	});

	it("backs Small with Medium and Medium with Small, both on the Mistral lane (CUR-2092)", async () => {
		H.flagsOn.add("side-call-own-lane");
		Object.assign(H.cfg, {
			MISTRAL_MODELS: `${MISTRAL_SMALL},${MISTRAL_MEDIUM}`,
			ARITHMETIC_ROUTE_MODEL: MISTRAL_MEDIUM,
		});
		const mod = await boot();

		const lanes = (id: string) =>
			(mod.models.find((m) => m.id === id)?.endpoints ?? []).map((e) => ({
				baseURL: e.baseURL,
				modelId: "modelId" in e ? e.modelId : undefined,
			}));
		expect(lanes(MISTRAL_SMALL)).toEqual([
			{ baseURL: MISTRAL_BASE, modelId: undefined },
			{ baseURL: MISTRAL_BASE, modelId: MISTRAL_MEDIUM },
		]);
		expect(lanes(MISTRAL_MEDIUM)).toEqual([
			{ baseURL: MISTRAL_BASE, modelId: undefined },
			{ baseURL: MISTRAL_BASE, modelId: MISTRAL_SMALL },
		]);
	});

	it("gives a lone Mistral side-call model no backup lane rather than backing it with itself", async () => {
		H.flagsOn.add("side-call-own-lane");
		const mod = await boot();

		expect(mod.models.find((m) => m.id === MISTRAL_SMALL)?.endpoints).toHaveLength(1);
	});

	it("never offers the Mistral side-call model in the picker: it stays out of the allowlisted chat models", async () => {
		H.flagsOn.add("side-call-own-lane");
		H.flagsOn.add("model-picker");
		const mod = await boot();

		expect(mod.models.filter((m) => !m.unlisted).map((m) => m.id)).toEqual([CHAT_MODEL]);
	});
});

describe("a pinned GLM id in the allowlist is offered from the HF router, independent of the compare panel (CUR-1683)", () => {
	const HF = "https://router.huggingface.co/v1";
	const GLM = "zai-org/GLM-5.2";

	beforeEach(() => {
		H.flagsOn.add("model-picker");
		Object.assign(H.cfg, { HF_BASE_URL: HF, HF_TOKEN: "hf-key", HF_BILL_TO: "test-org" });
	});

	it("offers it listed on the router, though no second-opinion setting names it", async () => {
		H.cfg.MODEL_ALLOWLIST = `${CHAT_MODEL},${GLM}`;
		const mod = await boot();

		const offered = mod.models.filter((m) => m.id === GLM);
		expect(offered).toHaveLength(1);
		expect(offered[0].unlisted).toBe(false);
		expect(offered[0].endpoints).toMatchObject([
			{ baseURL: HF, apiKeyEnv: "HF_TOKEN", defaultHeaders: { "X-HF-Bill-To": "test-org" } },
		]);
		expect(mod.defaultModel.id).toBe(CHAT_MODEL);
	});

	it("does not offer a compare panelist just because the allowlist names it", async () => {
		H.cfg.MODEL_ALLOWLIST = `${CHAT_MODEL},${PANELIST}`;
		const mod = await boot();

		expect(mod.models.filter((m) => !m.unlisted).map((m) => m.id)).toEqual([CHAT_MODEL]);
	});
});
