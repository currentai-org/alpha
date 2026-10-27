/**
 * The model registry names provider keys by env var and never holds their values (CUR-2640).
 *
 * The registry is long-lived and serialized wherever a model object goes: a route sent it with
 * `endpoints[].apiKey` set (CUR-2643). Here every keyed lane the registry builds is
 * configured at once (gateway, catalog backup, HF pinned picker lane, Mistral direct with its backup,
 * Mistral side calls, compare panel, agent), the real registry boots, and its serialization is checked
 * for every key value. The lane builds are then checked to send the same key each lane sent before.
 *
 * Idioms mirror models.sideCall.spec.ts: `config` is a Proxy over a mutable object, `$app/environment`
 * says `building: true` so the module-eval boot is skipped, and bootModels() runs against a stubbed
 * live catalog.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ModelConfig } from "./models";

const BASE = "https://api.test/v1";
const FALLBACK_BASE = "https://backup.test/v1";
const HF_BASE = "https://router.huggingface.co/v1";
const MISTRAL_BASE = "https://api.mistral.test/v1";
const COMPARE_BASE = "https://compare.test/v1";
const CHAT_MODEL = "test-org/chat-model";
const GLM = "zai-org/GLM-5.2";
const MISTRAL_LARGE = "mistral-large-2512";
const MISTRAL_SMALL = "mistral-small-2603";
const PANELIST = "test-org/panelist";

// Fixture values, built rather than written out so no literal here reads as a credential to gitleaks.
const KEY_NAMES = [
	"OPENAI_API_KEY",
	"FALLBACK_API_KEY",
	"HF_TOKEN",
	"MISTRAL_API_KEY",
	"SECOND_OPINION_API_KEY",
	"AGENT_SERVICE_TOKEN",
] as const;
const KEYS = Object.fromEntries(
	KEY_NAMES.map((name, i) => [name, `fixture-${name.toLowerCase()}-${i + 1}${i + 1}${i + 1}${i + 1}`])
) as Record<(typeof KEY_NAMES)[number], string>;

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string>,
	flagsOn: new Set<string>(),
	builds: [] as Array<{ type: string; baseURL?: string; apiKey?: string; modelId?: string }>,
}));

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

// Agent mode registers only on preview and production. Only this module is told so: a real deploy env
// would also swap MODEL_ALLOWLIST for the committed picker (primaryModel.ts).
vi.mock("$lib/chat/server/deployEnv", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/deployEnv")>()),
	deployEnv: () => "preview",
}));

vi.mock("$app/environment", () => ({ building: true, dev: false, browser: false, version: "test" }));

vi.mock("$lib/chat/server/data/models-snapshot.json", () => ({
	default: { fetchedAt: "", baseURL: "", entries: [] },
}));

// Records what each lane is built with, which is the call-time seam the key is resolved at.
vi.mock("./endpoints/endpoints", () => {
	const record =
		(type: string) =>
		async (input: { baseURL?: string; apiKey?: string; modelId?: string }) => {
			H.builds.push({ type, baseURL: input.baseURL, apiKey: input.apiKey, modelId: input.modelId });
			return async () => (async function* () {})();
		};
	const endpoints = { openai: record("openai"), agent: record("agent") };
	return { default: endpoints, endpoints };
});

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
	H.builds.length = 0;
	H.flagsOn.clear();
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, KEYS, {
		OPENAI_BASE_URL: BASE,
		FALLBACK_BASE_URL: FALLBACK_BASE,
		HF_BASE_URL: HF_BASE,
		HF_BILL_TO: "test-org",
		MISTRAL_BASE_URL: MISTRAL_BASE,
		MISTRAL_MODELS: `${MISTRAL_LARGE},${MISTRAL_SMALL}`,
		MODEL_ALLOWLIST: `${CHAT_MODEL},${MISTRAL_LARGE},${GLM}`,
		TASK_MODEL: MISTRAL_SMALL,
		SECOND_OPINION_BASE_URL: COMPARE_BASE,
		COMPARE_PANEL: PANELIST,
		AGENT_SERVICE_URL: "https://agent.test",
	});
	for (const flag of ["model-picker", "side-call-own-lane", "agent-mode"])
		H.flagsOn.add(flag);
	vi.stubEnv("CI_HERMETIC", "true");
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
	vi.unstubAllEnvs();
});

const boot = async () => {
	const mod = await import("./models");
	await mod.bootModels();
	return mod;
};

describe("model registry keys (CUR-2640)", () => {
	it("model registry objects carry no provider key values, only env var names", async () => {
		const mod = await boot();
		const ids = mod.models.map((m) => m.id);
		// Every keyed lane is in the registry, so the check below covers each of them.
		expect(ids).toEqual(
			expect.arrayContaining([CHAT_MODEL, MISTRAL_LARGE, GLM, MISTRAL_SMALL, PANELIST, "potluck-agent"])
		);

		const serialized = JSON.stringify(mod.models);
		for (const [name, value] of Object.entries(KEYS)) {
			expect(serialized, `${name}'s value is on a model object`).not.toContain(value);
		}
		for (const name of [
			"FALLBACK_API_KEY",
			"HF_TOKEN",
			"MISTRAL_API_KEY",
			"SECOND_OPINION_API_KEY",
			"AGENT_SERVICE_TOKEN",
		]) {
			expect(serialized).toContain(`"apiKeyEnv":"${name}"`);
		}
	});

	it("sends each lane the key it sent before, read from config when the lane is built", async () => {
		const mod = await boot();
		const keysFor = async (id: string) => {
			H.builds.length = 0;
			await mod.models.find((m) => m.id === id)!.getEndpoint();
			return H.builds.map((b) => [b.baseURL, b.apiKey]);
		};

		// Primary on the gateway: no key of its own, so endpointOai's default (OPENAI_API_KEY) applies.
		// Then the same model on the backup host with that host's key, and no other model (CUR-3936).
		expect(await keysFor(CHAT_MODEL)).toEqual([
			[BASE, undefined],
			[FALLBACK_BASE, KEYS.FALLBACK_API_KEY],
		]);
		expect(await keysFor(MISTRAL_LARGE)).toEqual([[MISTRAL_BASE, KEYS.MISTRAL_API_KEY]]);
		expect(await keysFor(GLM)).toEqual([[HF_BASE, KEYS.HF_TOKEN]]);
		expect(await keysFor(MISTRAL_SMALL)).toEqual([[MISTRAL_BASE, KEYS.MISTRAL_API_KEY]]);
		expect(await keysFor(PANELIST)).toEqual([[COMPARE_BASE, KEYS.SECOND_OPINION_API_KEY]]);
		expect(await keysFor("potluck-agent")).toEqual([["https://agent.test", KEYS.AGENT_SERVICE_TOKEN]]);
	});

	// Stop must not build the cancel from the bare registry entry, which has no `model` and no
	// key: the schema would throw before any DELETE went out, and the task would run on and save its file. (CUR-4602)
	it("Stop's cancel reaches agent-service with the token and visitor subject the turn's own submit sends", async () => {
		const mod = await boot();
		const { cancelAgentTask, agentServiceHeaders } = await import("./endpoints/agent/endpointAgent");
		const sent: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				sent.push({ url: String(url), method: init.method, headers: init.headers as Record<string, string> });
				return new Response(JSON.stringify({ id: "task-1", state: "CANCELED" }), { status: 200 });
			})
		);
		const locals = { sessionId: "visitor-session" } as App.Locals;

		const input = mod.agentModelLaneInput();
		expect(input, "the registry has an agent model, so Stop has an input to cancel with").toBeDefined();
		const status = await cancelAgentTask(input!, locals, { taskId: "task-1", machineId: "m-1" });

		expect(status).toBe(200);
		const turnHeaders = agentServiceHeaders(KEYS.AGENT_SERVICE_TOKEN, locals);
		expect(sent).toEqual([
			{
				url: "https://agent.test/run/task-1",
				method: "DELETE",
				headers: expect.objectContaining({
					authorization: `Bearer ${KEYS.AGENT_SERVICE_TOKEN}`,
					"x-agent-subject": turnHeaders["x-agent-subject"],
					"Fly-Force-Instance-Id": "m-1",
				}),
			},
		]);
	});

	it("leaves the catalog backup on the default key when FALLBACK_API_KEY is unset, as before", async () => {
		H.cfg.FALLBACK_API_KEY = "";
		const mod = await boot();
		const chat = mod.models.find((m) => m.id === CHAT_MODEL)!;
		expect(chat.endpoints?.[1]).not.toHaveProperty("apiKeyEnv");
		await chat.getEndpoint();
		expect(H.builds.map((b) => b.apiKey)).toEqual([undefined, undefined]);
	});

	it("drops a backup lane that names another model, so a picked model is answered only by itself (CUR-3936)", async () => {
		H.cfg.FALLBACK_MODEL_ID = "aisingapore/Gemma-SEA-LION-v4-27B-IT";
		const mod = await boot();
		const asks = (id: string) =>
			(mod.models.find((m) => m.id === id)!.endpoints ?? []).map((e) => {
				const l = e as { modelId?: string; servedAs?: string };
				return l.servedAs ?? l.modelId ?? id;
			});
		expect(asks(CHAT_MODEL)).toEqual([CHAT_MODEL]);
		expect(asks(MISTRAL_LARGE)).toEqual([MISTRAL_LARGE]);
	});

	it("types a registry endpoint so it cannot hold a string key", () => {
		type Endpoint = NonNullable<ModelConfig["endpoints"]>[number];
		type OpenAIEndpoint = Extract<Endpoint, { type: "openai" }>;
		type AgentEndpoint = Extract<Endpoint, { type: "agent" }>;
		const key: string = KEYS.OPENAI_API_KEY;
		// The openai lane allows only the local endpoint's fixed placeholder (localModels.ts).
		// @ts-expect-error a provider key value has no place on a registry endpoint (CUR-2640)
		const openaiKey: OpenAIEndpoint["apiKey"] = key;
		const agentHasNoKey: "apiKey" extends keyof AgentEndpoint ? false : true = true;
		expect([openaiKey, agentHasNoKey]).toEqual([key, true]);
	});
});
