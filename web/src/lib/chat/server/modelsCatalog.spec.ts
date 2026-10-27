import { describe, expect, it, vi } from "vitest";
import { tricksFor } from "./harnessProfiles";

// Endpoints name the env var their key lives in (CUR-2640); the lane builders read it to check the key
// is set. These are the only keys this file's config holds.
vi.mock("$lib/chat/server/config", () => {
	const cfg: Record<string, string> = { MISTRAL_API_KEY: "test-key", HF_TOKEN: "hf-key" };
	const config = new Proxy(cfg, { get: (t, prop) => (prop in t ? Reflect.get(t, prop) : "") });
	return { config, ready: Promise.resolve() };
});
import {
	applyOverrides,
	parseDirectEndpoint,
	routeDirectModels,
	hfPinnedLane,
	selectAllowedModels,
	toModelConfigs,
	withOnlyPickedModelLanes,
	withDirectModels,
} from "./modelsCatalog";
import type { CatalogEntry, ModelConfig, ModelOverride } from "./models";

// Minimal CatalogEntry fixtures. The shape mirrors the upstream /models payload (id required, the
// rest nullish), so plain objects suffice — the registry-side schema parse happens before this layer.
const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
	({ id, ...extra }) as CatalogEntry;

describe("selectAllowedModels", () => {
	const data = [entry("swiss-ai/Apertus-70B"), entry("meta/llama-3"), entry("mistral/large")];

	it("returns the full catalog for the wildcard specs", () => {
		expect(selectAllowedModels(data, "*")).toBe(data);
		expect(selectAllowedModels(data, "all")).toBe(data);
		expect(selectAllowedModels(data, "ALL")).toBe(data);
	});

	it("returns the full catalog when the spec is empty/whitespace", () => {
		expect(selectAllowedModels(data, "")).toBe(data);
		expect(selectAllowedModels(data, "   ")).toBe(data);
	});

	it("keeps only allowlisted ids", () => {
		const result = selectAllowedModels(data, "mistral/large");
		expect(result.map((m) => m.id)).toEqual(["mistral/large"]);
	});

	it("orders by the allowlist, not the upstream catalog order (first → defaultModel)", () => {
		const result = selectAllowedModels(data, "mistral/large, swiss-ai/Apertus-70B");
		expect(result.map((m) => m.id)).toEqual(["mistral/large", "swiss-ai/Apertus-70B"]);
	});

	it("ignores allowlisted ids the catalog does not contain", () => {
		const result = selectAllowedModels(data, "meta/llama-3, ghost/model");
		expect(result.map((m) => m.id)).toEqual(["meta/llama-3"]);
	});

	it("returns empty (fail loud) when the allowlist matches nothing, rather than widening to the full catalog", () => {
		const result = selectAllowedModels(data, "ghost/one, ghost/two");
		expect(result).toEqual([]);
	});
});

describe("toModelConfigs", () => {
	const opts = { baseURL: "https://api.example/v1", isHFRouter: true, multimodalEnabled: false };

	it("derives the HF org avatar logo for a slashed id on the HF router", () => {
		const [m] = toModelConfigs([entry("swiss-ai/Apertus-70B")], opts);
		expect(m.logoUrl).toBe("https://huggingface.co/api/avatars/swiss-ai");
	});

	it("gives a visitor a readable name, never the wire id, while id and name keep the wire id (CUR-2203)", () => {
		const [m] = toModelConfigs([entry("swiss-ai/apertus-v1.5-70b")], opts);
		expect(m.displayName).toBe("Apertus 1.5 70B");
		expect(m.id).toBe("swiss-ai/apertus-v1.5-70b");
		expect(m.name).toBe("swiss-ai/apertus-v1.5-70b");
	});

	it("does not derive a logo when not on the HF router", () => {
		const [m] = toModelConfigs([entry("swiss-ai/Apertus-70B")], { ...opts, isHFRouter: false });
		expect(m.logoUrl).toBeUndefined();
	});

	it("does not derive a logo for an unslashed id", () => {
		const [m] = toModelConfigs([entry("gpt-foo")], opts);
		expect(m.logoUrl).toBeUndefined();
	});

	it("forces non-multimodal when multimodal is gated off, even if the model advertises vision", () => {
		const [m] = toModelConfigs(
			[
				entry("x/y", {
					architecture: { input_modalities: ["text", "Image"] },
				} as Partial<CatalogEntry>),
			],
			opts
		);
		expect(m.multimodal).toBe(false);
		expect(m.multimodalAcceptedMimetypes).toBeUndefined();
	});

	it("enables multimodal when gated on and the model accepts image/vision input", () => {
		const [m] = toModelConfigs(
			[
				entry("x/y", {
					architecture: { input_modalities: ["text", "vision"] },
				} as Partial<CatalogEntry>),
			],
			{ ...opts, multimodalEnabled: true }
		);
		expect(m.multimodal).toBe(true);
		expect(m.multimodalAcceptedMimetypes).toEqual(["image/*"]);
	});

	it("a catalogued model reads images exactly as the catalog records it, whatever its host lists", () => {
		const [large, apertus, alia, aliaClaimed] = toModelConfigs(
			[
				entry("mistralai/mistral-large-2512"),
				entry("swiss-ai/apertus-v1.5-70b"),
				entry("BSC-LT/ALIA-40b-instruct"),
				// A host claiming image input for a model that was observed refusing images is not believed.
				entry("BSC-LT/ALIA-40b-instruct", {
					architecture: { input_modalities: ["text", "image"] },
				} as Partial<CatalogEntry>),
			],
			{ ...opts, multimodalEnabled: true }
		);
		expect(large.multimodal).toBe(true);
		expect(large.multimodalAcceptedMimetypes).toEqual(["image/*"]);
		expect(apertus.multimodal).toBe(true);
		expect(alia.multimodal).toBe(false);
		expect(aliaClaimed.multimodal).toBe(false);
	});

	it("a model reads no images while the multimodal gate is shut, even one the catalog says reads them", () => {
		const [shut] = toModelConfigs([entry("mistralai/mistral-large-2512")], opts);
		expect(shut.multimodal).toBe(false);
	});

	it("aggregates tool support across providers", () => {
		const withTools = toModelConfigs(
			[entry("x/y", { providers: [{ supports_tools: false }, { supports_tools: true }] })],
			opts
		);
		const noTools = toModelConfigs(
			[entry("x/y", { providers: [{ supports_tools: false }] })],
			opts
		);
		expect(withTools[0].supportsTools).toBe(true);
		expect(noTools[0].supportsTools).toBe(false);
	});

	it("a gateway entry with no providers field takes tool support from its row, and an unmeasured one stays tool-less (CUR-4191)", () => {
		// The LiteLLM gateway's /models carries only id, object, created and owned_by.
		const [alia, unmeasured] = toModelConfigs(
			[entry("BSC-LT/ALIA-40b-instruct"), entry("aisingapore/Gemma-SEA-LION-v4-27B-IT")],
			opts
		);
		expect(alia.supportsTools).toBe(true);
		expect(unmeasured.supportsTools).toBe(false);
	});

	it("carries the baseURL onto an openai endpoint", () => {
		const [m] = toModelConfigs([entry("x/y")], opts);
		expect(m.endpoints?.[0]).toMatchObject({ type: "openai", baseURL: "https://api.example/v1" });
	});

	it("stays single-lane when no fallback base URL is configured", () => {
		const [m] = toModelConfigs([entry("x/y")], opts);
		expect(m.endpoints).toHaveLength(1);
	});

	it("adds a distinct backup lane naming its own key env var when a fallback is configured", () => {
		const [m] = toModelConfigs([entry("swiss-ai/Apertus-70B")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api.swissai.example/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
		});
		expect(m.endpoints).toHaveLength(2);
		expect(m.endpoints?.[0]).toMatchObject({ baseURL: "https://api.swissai.example/v1" });
		expect(m.endpoints?.[1]).toMatchObject({
			type: "openai",
			baseURL: "https://router.huggingface.co/v1",
			apiKeyEnv: "HF_TOKEN",
		});
	});

	// Named for the failure, not the field: without this header the HF router 403s a personal token
	// on arrival — "does not have sufficient permissions to call Inference Providers" — so every
	// failover fails and looks exactly like a lane nothing had reason to use.
	it("sends the billing header on the backup lane, or the HF router 403s every failover", () => {
		const [m] = toModelConfigs([entry("swiss-ai/Apertus-70B")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api.swissai.example/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
			fallbackBillTo: "current-ai-official",
		});
		expect(m.endpoints?.[1]).toMatchObject({
			defaultHeaders: { "X-HF-Bill-To": "current-ai-official" },
		});
	});

	it("omits the billing header when no billing org is configured, rather than sending an empty one", () => {
		const [m] = toModelConfigs([entry("swiss-ai/Apertus-70B")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api.swissai.example/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
		});
		expect(m.endpoints?.[1]).not.toHaveProperty("defaultHeaders");
	});

	it("does not add a backup lane when the fallback URL equals the primary (no pointless dup)", () => {
		const [m] = toModelConfigs([entry("x/y")], {
			...opts,
			baseURL: "https://api.example/v1",
			fallbackBaseURL: "https://api.example/v1/", // trailing slash normalized → same host+path
		});
		expect(m.endpoints).toHaveLength(1);
	});

	// The HF router serves no Apertus 70B, so production's backup is the gateway's
	// Infomaniak-only Apertus group, on the primary's own host. Dropping that lane as a duplicate would
	// leave a 12 s gateway stall with nowhere to go. (CUR-2293)
	it("keeps a backup lane on the primary's own host when it asks for a different model, with the primary's key and no HF billing", () => {
		const [m] = toModelConfigs([entry("swiss-ai/apertus-v1.5-70b")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api-internal.publicai.co/v1",
			fallbackBaseURL: "https://api-internal.publicai.co/v1",
			fallbackApiKeyEnv: "",
			fallbackModelId: "swiss-ai/apertus-v1.5-70b-thinking",
			fallbackBillTo: "",
		});
		expect(m.endpoints).toHaveLength(2);
		const backup = m.endpoints?.[1] as Record<string, unknown>;
		expect(backup).toMatchObject({
			baseURL: "https://api-internal.publicai.co/v1",
			modelId: "swiss-ai/apertus-v1.5-70b-thinking",
		});
		expect(backup).not.toHaveProperty("apiKey");
		expect(backup).not.toHaveProperty("apiKeyEnv");
		expect(backup).not.toHaveProperty("defaultHeaders");
	});

	it("adds NO model override to the backup lane by default (same-id failover unchanged)", () => {
		const [m] = toModelConfigs([entry("swiss-ai/apertus-70b-instruct")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api-internal.publicai.co/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
		});
		expect((m.endpoints?.[1] as Record<string, unknown>).modelId).toBeUndefined();
	});

	it("puts the FALLBACK_MODEL_ID override on the backup lane ONLY (cross-model failover)", () => {
		const [m] = toModelConfigs([entry("swiss-ai/apertus-70b-instruct")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api-internal.publicai.co/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
			fallbackModelId: "zai-org/GLM-5.2",
		});
		const [primary, backup] = (m.endpoints ?? []) as unknown as Record<string, unknown>[];
		expect(primary.modelId).toBeUndefined(); // primary still requests its own catalog id
		expect(backup.modelId).toBe("zai-org/GLM-5.2");
	});

	// CUR-3750. A list is one backup lane per id, in order, so a silent first backup has a lane behind it.
	it("makes one backup lane per listed id, in order", () => {
		const [m] = toModelConfigs([entry("mistral-large-2512")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api-internal.publicai.co/v1",
			fallbackBaseURL: "https://api.sea-lion.example/v1",
			fallbackModelId: "aisingapore/Gemma-SEA-LION-v4-27B-IT, aisingapore/Qwen-SEA-LION-v4-32B-IT",
		});
		expect((m.endpoints ?? []).map((e) => (e as Record<string, unknown>).modelId)).toEqual([
			undefined,
			"aisingapore/Gemma-SEA-LION-v4-27B-IT",
			"aisingapore/Qwen-SEA-LION-v4-32B-IT",
		]);
	});

	it("drops a listed backup that would repeat the primary's own call, and keeps the rest", () => {
		const [m] = toModelConfigs([entry("aisingapore/Gemma-SEA-LION-v4-27B-IT")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api.sea-lion.example/v1",
			fallbackBaseURL: "https://api.sea-lion.example/v1",
			fallbackModelId: "aisingapore/Gemma-SEA-LION-v4-27B-IT,aisingapore/Qwen-SEA-LION-v4-32B-IT",
		});
		expect((m.endpoints ?? []).map((e) => (e as Record<string, unknown>).modelId)).toEqual([
			undefined,
			"aisingapore/Qwen-SEA-LION-v4-32B-IT",
		]);
	});

	it("skips the override when it equals the entry's own id (no pointless field)", () => {
		const [m] = toModelConfigs([entry("zai-org/GLM-5.2")], {
			...opts,
			isHFRouter: false,
			baseURL: "https://api-internal.publicai.co/v1",
			fallbackBaseURL: "https://router.huggingface.co/v1",
			fallbackModelId: "zai-org/GLM-5.2",
		});
		expect((m.endpoints?.[1] as Record<string, unknown>).modelId).toBeUndefined();
	});
});

describe("applyOverrides", () => {
	const base: ModelConfig[] = [
		{ id: "a/one", name: "a/one" } as ModelConfig,
		{ id: "b/two", name: "b/two" } as ModelConfig,
	];

	it("returns the configs untouched when there are no overrides", () => {
		expect(applyOverrides(base, [])).toBe(base);
	});

	it("merges an override matched by id and strips the id/name selectors", () => {
		const overrides = [{ id: "a/one", supportsArtifacts: true } as ModelOverride];
		const result = applyOverrides(base, overrides);
		expect(result[0]).toMatchObject({ id: "a/one", name: "a/one", supportsArtifacts: true });
		// untouched entry passes through by reference
		expect(result[1]).toBe(base[1]);
	});

	it("matches by name when the id does not match", () => {
		const overrides = [{ name: "b/two", description: "overridden" } as ModelOverride];
		const result = applyOverrides(base, overrides);
		expect(result[1]).toMatchObject({ id: "b/two", description: "overridden" });
	});

	it("leaves a config untouched when no override targets it", () => {
		const overrides = [{ id: "c/three", description: "nope" } as ModelOverride];
		const result = applyOverrides(base, overrides);
		expect(result[0]).toBe(base[0]);
		expect(result[1]).toBe(base[1]);
	});
});

describe("direct endpoint models (CUR-2272)", () => {
	const gateway = [entry("swiss-ai/apertus-v1.5-70b")];
	const direct = parseDirectEndpoint(
		"https://api.mistral.ai/v1/",
		"MISTRAL_API_KEY",
		"mistral-large-2512",
		"mistral"
	);
	const shape = (data: CatalogEntry[]) =>
		toModelConfigs(data, {
			baseURL: "https://gateway.example/v1",
			isHFRouter: false,
			multimodalEnabled: false,
			fallbackBaseURL: "https://router.example/v1",
			fallbackApiKeyEnv: "HF_TOKEN",
		});

	it("a direct model its maker says reads images is multimodal only while the multimodal gate is open (CUR-454)", () => {
		const open = toModelConfigs(withDirectModels(gateway, direct), {
			baseURL: "https://gateway.example/v1",
			isHFRouter: false,
			multimodalEnabled: true,
		});
		const large = open.find((m) => m.id === "mistral-large-2512");
		expect(large?.multimodal).toBe(true);
		expect(large?.multimodalAcceptedMimetypes).toEqual(["image/*"]);

		const shut = shape(withDirectModels(gateway, direct)).find((m) => m.id === "mistral-large-2512");
		expect(shut?.multimodal).toBe(false);
	});

	it("a direct model not known to read images stays text-only with the multimodal gate open (CUR-454)", () => {
		const other = parseDirectEndpoint("https://api.mistral.ai/v1/", "MISTRAL_API_KEY", "codestral-2508", "mistral");
		const [config] = toModelConfigs(withDirectModels([], other), {
			baseURL: "https://gateway.example/v1",
			isHFRouter: false,
			multimodalEnabled: true,
		});
		expect(config.multimodal).toBe(false);
	});

	it("lets the allowlist put a direct model first, so it becomes the default", () => {
		const allowed = selectAllowedModels(
			withDirectModels(gateway, direct),
			"mistral-large-2512, swiss-ai/apertus-v1.5-70b"
		);
		expect(allowed.map((m) => m.id)).toEqual(["mistral-large-2512", "swiss-ai/apertus-v1.5-70b"]);
	});

	it("routes a direct model to its own host only, with no gateway backup lane, and names its provider", () => {
		const configs = routeDirectModels(shape(withDirectModels(gateway, direct)), direct);
		const large = configs.find((m) => m.id === "mistral-large-2512");
		expect(large?.endpoints).toEqual([
			{
				type: "openai",
				baseURL: "https://api.mistral.ai/v1",
				apiKeyEnv: "MISTRAL_API_KEY",
				routerProvider: "mistral",
			},
		]);
		expect(large?.supportsTools).toBe(true);
		const apertus = configs.find((m) => m.id === "swiss-ai/apertus-v1.5-70b");
		expect(apertus?.endpoints?.[0]).toMatchObject({ baseURL: "https://gateway.example/v1" });
		expect(apertus?.endpoints).toHaveLength(2);
	});

	it("asks a router that renames the model for its own id, and records the answer under ours (CUR-2928)", () => {
		const router = parseDirectEndpoint(
			"https://api.mistral.ai/v1/",
			"MISTRAL_API_KEY",
			"mistral-large-2512",
			"mistral",
			{ "mistral-large-2512": "mistralai/mistral-large-2512" }
		);
		const configs = routeDirectModels(shape(withDirectModels(gateway, router)), router);
		const large = configs.find((m) => m.id === "mistral-large-2512");
		expect(large?.endpoints?.[0]).toMatchObject({
			modelId: "mistralai/mistral-large-2512",
			servedAs: "mistral-large-2512",
		});
		expect(large?.endpoints).toHaveLength(1);
	});


	it("registers nothing, and says so, when the config is only partly set (fail loud, not a half-built lane)", () => {
		expect(parseDirectEndpoint("https://api.mistral.ai/v1", "UNSET_KEY", "mistral-large-2512")).toBeNull();
		expect(selectAllowedModels(withDirectModels(gateway, null), "mistral-large-2512")).toEqual([]);
	});

	it("is a no-op when nothing is configured", () => {
		expect(parseDirectEndpoint("", "UNSET_KEY", "")).toBeNull();
		expect(withDirectModels(gateway, null)).toBe(gateway);
	});
});

describe("a pinned model on the HF router as a picker lane (CUR-1683)", () => {
	const gateway = [entry("swiss-ai/apertus-v1.5-70b")];
	const HF = "https://router.huggingface.co/v1";
	const shape = (data: CatalogEntry[]) =>
		toModelConfigs(data, {
			baseURL: "https://gateway.example/v1",
			isHFRouter: false,
			multimodalEnabled: false,
		});

	it("offers an allowlisted id with a provider pin from the router, billed, with its reasoning left on and its own row's tricks, none (CUR-2697)", () => {
		const allowlist = "swiss-ai/apertus-v1.5-70b, zai-org/GLM-5.2";
		const lane = hfPinnedLane(`${HF}/`, "HF_TOKEN", "test-org", allowlist);
		expect(lane?.modelIds).toEqual(["zai-org/GLM-5.2"]);
		const allowed = selectAllowedModels(withDirectModels(gateway, lane), allowlist);
		expect(allowed.map((m) => m.id)).toEqual(["swiss-ai/apertus-v1.5-70b", "zai-org/GLM-5.2"]);
		const glm = routeDirectModels(shape(allowed), lane).find((m) => m.id === "zai-org/GLM-5.2");
		expect(glm?.endpoints).toEqual([
			{
				type: "openai",
				baseURL: HF,
				apiKeyEnv: "HF_TOKEN",
				defaultHeaders: { "X-HF-Bill-To": "test-org" },
			},
		]);
		// An id that missed its row would get every trick, so an empty set shows the routed id found it.
		expect([...tricksFor(glm?.id)]).toEqual([]);
	});

	it("never offers a GLM id with no provider pin, so the router cannot pick who receives its text", () => {
		expect(hfPinnedLane(HF, "HF_TOKEN", "test-org", "zai-org/GLM-5.3")).toBeNull();
	});

	it("offers nothing the allowlist does not name, and nothing when the router, its key, or a router URL is missing", () => {
		expect(hfPinnedLane(HF, "HF_TOKEN", "", "swiss-ai/apertus-v1.5-70b")).toBeNull();
		expect(hfPinnedLane("", "HF_TOKEN", "", "zai-org/GLM-5.2")).toBeNull();
		expect(hfPinnedLane(HF, "UNSET_KEY", "", "zai-org/GLM-5.2")).toBeNull();
		expect(hfPinnedLane("https://gateway.example/v1", "HF_TOKEN", "", "zai-org/GLM-5.2")).toBeNull();
	});
});

describe("withOnlyPickedModelLanes: a pick is answered by itself, retried, or not at all (CUR-3936)", () => {
	const at = (url: string, modelId?: string, servedAs?: string) => ({
		type: "openai" as const,
		baseURL: url,
		...(modelId ? { modelId } : {}),
		...(servedAs ? { servedAs } : {}),
	});
	const model = (id: string, endpoints: unknown[]) => ({ id, name: id, endpoints }) as unknown as ModelConfig;
	const asks = (m?: ModelConfig) =>
		(m?.endpoints ?? []).map((e) => {
			const l = e as { modelId?: string; servedAs?: string };
			return l.servedAs ?? l.modelId ?? m?.id;
		});

	it("drops every SEA-LION lane behind an Apertus pick, the substitution that answered Apertus with Gemma", () => {
		const apertus = model("swiss-ai/apertus-v1.5-70b", [
			at("https://gateway.example/v1"),
			at("https://sealion.example/v1", "aisingapore/Gemma-SEA-LION-v4-27B-IT"),
			at("https://api.mistral.ai/v1", "mistral-medium-2604"),
		]);
		expect(asks(withOnlyPickedModelLanes([apertus])[0])).toEqual(["swiss-ai/apertus-v1.5-70b"]);
	});

	it("keeps a retry of the picked model on another host, case differences included", () => {
		const apertus = model("swiss-ai/apertus-v1.5-70b", [
			at("https://adapter.example/v1"),
			at("https://gateway.example/v1"),
			at("https://router.example/v1", "swiss-ai/Apertus-v1.5-70B"),
		]);
		expect(withOnlyPickedModelLanes([apertus])[0].endpoints).toHaveLength(3);
	});

	it("drops Large 3's Medium lane: no pick is answered by another model, Large 3 included (CUR-4383)", () => {
		const large = model("mistral-large-2512", [
			at("https://api.mistral.ai/v1"),
			at("https://api.mistral.ai/v1", "mistral-medium-2604"),
		]);
		expect(asks(withOnlyPickedModelLanes([large])[0])).toEqual(["mistral-large-2512"]);
	});

	it("drops the Medium lane behind any other direct model too", () => {
		const small = model("mistral-small-2603", [
			at("https://api.mistral.ai/v1"),
			at("https://api.mistral.ai/v1", "mistral-medium-2604"),
		]);
		expect(asks(withOnlyPickedModelLanes([small])[0])).toEqual(["mistral-small-2603"]);
	});

	it("reads a wire id through servedAs, so a host's own spelling of the pick is still the pick", () => {
		const large = model("mistral-large-2512", [
			at("https://router.example/v1", "mistral/large-3", "mistral-large-2512"),
			at("https://router.example/v1", "mistral/medium-3.5", "mistral-medium-2604"),
			at("https://router.example/v1", "mistral/large-3-eu", "mistral-large-2512"),
		]);
		expect(asks(withOnlyPickedModelLanes([large])[0])).toEqual(["mistral-large-2512", "mistral-large-2512"]);
	});

	it("drops a substitute the full build adds, SEA-LION in FALLBACK_MODEL_ID plus a MODELS override, and logs nothing for a clean model", () => {
		const built = applyOverrides(
			toModelConfigs([entry("swiss-ai/apertus-v1.5-70b"), entry("BSC-LT/ALIA-40b-instruct")], {
				baseURL: "https://gateway.example/v1",
				isHFRouter: false,
				multimodalEnabled: false,
				fallbackBaseURL: "https://gateway.example/v1",
				fallbackModelId: "aisingapore/Gemma-SEA-LION-v4-27B-IT,aisingapore/Qwen-SEA-LION-v4-32B-IT",
			}),
			[]
		);
		expect(built[0].endpoints).toHaveLength(3);
		const guarded = withOnlyPickedModelLanes(built);
		expect(guarded.map(asks)).toEqual([["swiss-ai/apertus-v1.5-70b"], ["BSC-LT/ALIA-40b-instruct"]]);
	});

	it("returns a single-lane model unchanged", () => {
		const solo = model("zai-org/GLM-5.2", [at("https://router.example/v1", "zai-org/GLM-5.2:novita", "zai-org/GLM-5.2")]);
		expect(withOnlyPickedModelLanes([solo])[0]).toBe(solo);
	});
});
