import { describe, it, expect, vi, afterEach } from "vitest";

// embeddingToken() reads keys off the config proxy via Reflect.get, so we mock the config module
// with a plain object and assert the RAG-token precedence: HF_RAG_EMBEDDINGS_TOKEN must win over the
// shared inference keys, with OPENAI_API_KEY → HF_TOKEN as the backward-compatible fallback chain.
// vi.hoisted keeps `configValues` accessible inside the hoisted vi.mock factory.
const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));

import {
	embeddingToken,
	syft,
	syftEnabled,
	syftRouter,
	syftPromptOnly,
	syftPromptRoutingEnabled,
} from "./env";

describe("syft() — Pattern-A federated config", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
	});

	it("defaults: hosted base, sane discovery/retrieve knobs, guest off, no scope", () => {
		const c = syft();
		expect(c.token).toBe("");
		expect(c.baseUrl).toBe("https://syfthub.openmined.org");
		expect(c.discoveryTopK).toBe(5);
		expect(c.discoveryMinScore).toBe(0.4);
		expect(c.retrieveTopK).toBe(5);
		expect(c.similarityThreshold).toBe(0.5);
		expect(c.retrieveTimeoutMs).toBe(9000);
		expect(c.discoverTimeoutMs).toBe(3000);
		expect(c.guestMode).toBe(false);
		expect(c.discoveryCacheTtlMs).toBe(300000);
		expect(c.scopeTag).toBe("");
		expect(c.scopeOwner).toBe("");
		expect(c.sourceBlocklist).toEqual([]);
	});

	it("parses SYFTHUB_SOURCE_BLOCKLIST as trimmed lower-cased owner/slug paths", () => {
		configValues.SYFTHUB_SOURCE_BLOCKLIST = " Tempo/News , tempo/plus ,, ";
		const c = syft();
		expect(c.sourceBlocklist).toEqual(["tempo/news", "tempo/plus"]);
	});

	it("parses overrides, accepting 0 for score thresholds", () => {
		configValues.SYFTHUB_BASE_URL = "http://localhost:8080";
		configValues.SYFTHUB_DISCOVERY_MIN_SCORE = "0"; // accept-all is valid (readFloat allows 0)
		configValues.SYFTHUB_DISCOVERY_TOP_K = "12";
		configValues.SYFTHUB_DISCOVER_TIMEOUT_MS = "1500";
		configValues.SYFTHUB_GUEST_MODE = "true";
		configValues.SYFTHUB_SOURCE_TAG = "potluck";
		const c = syft();
		expect(c.baseUrl).toBe("http://localhost:8080");
		expect(c.discoveryMinScore).toBe(0);
		expect(c.discoveryTopK).toBe(12);
		expect(c.discoverTimeoutMs).toBe(1500);
		expect(c.guestMode).toBe(true);
		expect(c.scopeTag).toBe("potluck");
	});

	it("syftEnabled() gates on the token", () => {
		expect(syftEnabled()).toBe(false);
		configValues.SYFTHUB_API_TOKEN = "tok";
		expect(syftEnabled()).toBe(true);
	});
});

describe("syftRouter() — pre-flight router config", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
	});

	it("defaults: all gates OFF, primary-model fallback, sane budget knobs", () => {
		const r = syftRouter();
		expect(r.enabled).toBe(false);
		expect(r.shadow).toBe(false);
		expect(r.honorEmpty).toBe(false);
		expect(r.model).toBe(""); // empty ⇒ caller falls back to the primary served model
		expect(r.baseUrl).toBe(""); // empty ⇒ caller falls back to the main OPENAI_BASE_URL
		expect(r.apiKey).toBe(""); // empty ⇒ caller falls back to the main OPENAI_API_KEY chain
		expect(r.provider).toBe(""); // empty ⇒ caller falls back to the main OPENAI_PROVIDER pin
		expect(r.timeoutMs).toBe(4000);
		expect(r.maxEndpoints).toBe(3);
		expect(r.catalogTtlMs).toBe(3600000);
	});

	it("parses the RAG_ROUTER_* overrides (distinct from LLM_ROUTER_*)", () => {
		configValues.RAG_ROUTER_ENABLED = "true";
		configValues.RAG_ROUTER_SHADOW = "true";
		configValues.RAG_ROUTER_HONOR_EMPTY = "true";
		configValues.RAG_ROUTER_MODEL = "swiss-ai/Apertus-70B-Instruct-2509";
		configValues.RAG_ROUTER_BASE_URL = "https://router.huggingface.co/v1";
		configValues.RAG_ROUTER_API_KEY = "hf_router_lane";
		configValues.RAG_ROUTER_PROVIDER = "publicai";
		configValues.RAG_ROUTER_TIMEOUT_MS = "2500";
		configValues.RAG_ROUTER_MAX_ENDPOINTS = "5";
		configValues.RAG_ROUTER_CATALOG_TTL_MS = "60000";
		const r = syftRouter();
		expect(r).toMatchObject({
			enabled: true,
			shadow: true,
			honorEmpty: true,
			model: "swiss-ai/Apertus-70B-Instruct-2509",
			baseUrl: "https://router.huggingface.co/v1",
			apiKey: "hf_router_lane",
			provider: "publicai",
			timeoutMs: 2500,
			maxEndpoints: 5,
			catalogTtlMs: 60000,
		});
	});

	it("only the literal 'true' enables a gate", () => {
		configValues.RAG_ROUTER_ENABLED = "1";
		configValues.RAG_ROUTER_SHADOW = "yes";
		const r = syftRouter();
		expect(r.enabled).toBe(false);
		expect(r.shadow).toBe(false);
	});

	it("SYFTHUB_PROMPT_ONLY force-disables the router even when RAG_ROUTER_* are set", () => {
		configValues.RAG_ROUTER_ENABLED = "true";
		configValues.RAG_ROUTER_SHADOW = "true";
		expect(syftRouter()).toMatchObject({ enabled: true, shadow: true }); // baseline
		configValues.SYFTHUB_PROMPT_ONLY = "on";
		expect(syftRouter()).toMatchObject({ enabled: false, shadow: false }); // forced off
	});
});

describe("prompt-routing gates", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
	});

	it("both default OFF", () => {
		expect(syftPromptOnly()).toBe(false);
		expect(syftPromptRoutingEnabled()).toBe(false);
	});

	it("SYFTHUB_PROMPT_ROUTING enables routing (on/true), but not prompt-only", () => {
		configValues.SYFTHUB_PROMPT_ROUTING = "on";
		expect(syftPromptRoutingEnabled()).toBe(true);
		expect(syftPromptOnly()).toBe(false);
		configValues.SYFTHUB_PROMPT_ROUTING = "true";
		expect(syftPromptRoutingEnabled()).toBe(true);
		configValues.SYFTHUB_PROMPT_ROUTING = "1";
		expect(syftPromptRoutingEnabled()).toBe(false); // only on/true
	});

	it("SYFTHUB_PROMPT_ONLY implies routing", () => {
		configValues.SYFTHUB_PROMPT_ONLY = "true";
		expect(syftPromptOnly()).toBe(true);
		expect(syftPromptRoutingEnabled()).toBe(true); // implied even without SYFTHUB_PROMPT_ROUTING
	});
});

describe("embeddingToken — dedicated RAG token precedence", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
	});

	it("prefers HF_RAG_EMBEDDINGS_TOKEN over the shared inference keys", () => {
		configValues.HF_RAG_EMBEDDINGS_TOKEN = "hf_rag";
		configValues.OPENAI_API_KEY = "hf_openai";
		configValues.HF_TOKEN = "hf_shared";
		expect(embeddingToken()).toBe("hf_rag");
	});

	it("prefers HF-named tokens over OPENAI_API_KEY (the CSCS sk- chat key after the serving flip)", () => {
		// Chain: HF_RAG_EMBEDDINGS_TOKEN > HF_TOKEN > OPENAI_API_KEY. The embed endpoint is HF
		// feature-extraction (needs an hf_ token); OPENAI_API_KEY is the CSCS chat key, so it's the LAST
		// resort (only valid where it is itself the HF key).
		configValues.OPENAI_API_KEY = "hf_openai";
		configValues.HF_TOKEN = "hf_shared";
		expect(embeddingToken()).toBe("hf_shared"); // HF_TOKEN beats OPENAI_API_KEY

		delete configValues.HF_TOKEN;
		expect(embeddingToken()).toBe("hf_openai"); // last resort
	});

	it("never borrows the compare panel's SECOND_OPINION_API_KEY, so rotating it can't move embeddings (CUR-2265)", () => {
		configValues.SECOND_OPINION_API_KEY = "hf_second";
		configValues.OPENAI_API_KEY = "hf_openai";
		expect(embeddingToken()).toBe("hf_openai");
		delete configValues.OPENAI_API_KEY;
		expect(embeddingToken()).toBe("");
		delete configValues.SECOND_OPINION_API_KEY;
	});

	it("returns empty string when no token is configured", () => {
		expect(embeddingToken()).toBe("");
	});
});
