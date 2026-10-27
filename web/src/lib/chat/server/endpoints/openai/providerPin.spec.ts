import { describe, expect, it, vi } from "vitest";

// A lane names its key's env var; resolveClassifierLane reads the value from config (CUR-2640).
vi.mock("$lib/chat/server/config", () => {
	const cfg: Record<string, string> = { OWN_KEY: "own-key", BLANK_KEY: "  " };
	const config = new Proxy(cfg, { get: (t, prop) => (prop in t ? Reflect.get(t, prop) : "") });
	return { config, ready: Promise.resolve() };
});
import {
	describeServingLane,
	resolveClassifierLane,
	resolveProviderModelId,
	wireModelId,
} from "./providerPin";

const BASE = "swiss-ai/Apertus-70B-Instruct-2509";

/** The LiteLLM gateway — `config.OPENAI_BASE_URL`, the lane ordinary catalog models are built on. */
const GATEWAY = "https://api-internal.publicai.co/v1";
/** A per-model host — reachable ONLY as an endpoint override; nothing global points here. The compare
 *  panel is the live example (SECOND_OPINION_BASE_URL), and CSCS direct was another until CUR-243. */
const OWN_HOST = "https://api.swissai.svc.cscs.ch/v1";
/** A lane's own wire id, as opposed to the registration's internal id. endpointOai sends this verbatim
 *  and it deliberately bypasses the provider pin, which is the case the tests below are about. */
const OWN_WIRE_ID = "apertus-ai/Apertus-v1.5-70B";

describe("resolveProviderModelId — HF router default provider pin", () => {
	it("no provider + a default → pins the default (the warmup win, e.g. publicai)", () => {
		expect(resolveProviderModelId(BASE, undefined, "publicai")).toBe(`${BASE}:publicai`);
	});

	it("no provider + no default → bare model id (router auto-selects, current upstream behavior)", () => {
		expect(resolveProviderModelId(BASE, undefined, undefined)).toBe(BASE);
		expect(resolveProviderModelId(BASE, undefined, "")).toBe(BASE);
		expect(resolveProviderModelId(BASE, undefined, "   ")).toBe(BASE);
	});

	it("explicit override wins over the default", () => {
		expect(resolveProviderModelId(BASE, "together", "publicai")).toBe(`${BASE}:together`);
	});

	it('explicit "auto" honors the user\'s choice — no pin even when a default is set', () => {
		expect(resolveProviderModelId(BASE, "auto", "publicai")).toBe(BASE);
	});

	it("trims a padded default", () => {
		expect(resolveProviderModelId(BASE, undefined, " publicai ")).toBe(`${BASE}:publicai`);
	});
});

describe("describeServingLane — what the [ttft] log says about where a turn went", () => {
	it("names the model's OWN host, not the global gateway, when the model overrides its endpoint", () => {
		// The contract this function exists for: report the model's own endpoint, never the global.
		// Reading config.OPENAI_BASE_URL logs a host a turn never touched whenever a model overrides its
		// endpoint. No live config overrides one now, so this scenario is injected rather than reproduced
		// from deployed values: the contract is what makes the [ttft] log trustworthy the next time any
		// model overrides its endpoint, and the compare panel already does. A test that only reproduced the
		// deployed values would stop guarding anything the moment the deployment changed.
		const { baseHost } = describeServingLane(
			{ id: "own-lane-model", endpoints: [{ type: "openai", baseURL: OWN_HOST, modelId: OWN_WIRE_ID }] },
			GATEWAY,
			"publicai"
		);
		expect(baseHost).toBe("api.swissai.svc.cscs.ch");
		expect(baseHost).not.toBe("api-internal.publicai.co");
	});

	it("reports a lane modelId VERBATIM — never the internal id, never provider-pinned", () => {
		// endpointOai sends `laneModelId ?? resolveProviderModelId(...)`, and a lane id deliberately
		// bypasses the pin (":publicai" on a CSCS id would 400). The log has to match the wire or it
		// names an id nobody sent.
		const { resolvedModelId } = describeServingLane(
			{ id: "own-lane-model", endpoints: [{ type: "openai", baseURL: OWN_HOST, modelId: OWN_WIRE_ID }] },
			GATEWAY,
			"publicai"
		);
		expect(resolvedModelId).toBe(OWN_WIRE_ID);
	});

	it("mirrors the wire on an EMPTY lane id — reports what was sent, not what would have worked", () => {
		// Locks `??` against `||`. endpointOai sends `laneModelId ?? resolveProviderModelId(...)`, so an
		// empty lane id goes on the wire as an empty model. Falling back to the pinned id here would make
		// the log describe a request we did not make — the exact class of bug this function fixes. No
		// current config produces "" (both call sites guard on truthiness); this pins the operator so a
		// later one can't quietly reintroduce the divergence.
		const { resolvedModelId } = describeServingLane(
			{ id: BASE, endpoints: [{ type: "openai", baseURL: OWN_HOST, modelId: "" }] },
			GATEWAY,
			"publicai"
		);
		expect(resolvedModelId).toBe("");
	});

	it("leaves an ordinary catalog model unchanged — gateway host, provider-pinned id", () => {
		// Catalog models build endpoints[0] FROM config.OPENAI_BASE_URL and set no lane modelId
		// (modelsCatalog.ts), so the fix must be a no-op for the overwhelming majority of turns.
		const { baseHost, resolvedModelId } = describeServingLane(
			{ id: BASE, endpoints: [{ type: "openai", baseURL: GATEWAY }] },
			GATEWAY,
			"publicai"
		);
		expect(baseHost).toBe("api-internal.publicai.co");
		expect(resolvedModelId).toBe(`${BASE}:publicai`);
	});

	it("reports the FIRST lane, not a backup — this field is routing, not served identity", () => {
		// The documented limit, asserted so it cannot drift into an unstated claim. withFailover can fall
		// through to endpoints[1] before any output; this line still names the primary. Anyone wanting to
		// know which model ANSWERED reads provenance on the persisted message, not this.
		const { baseHost, resolvedModelId } = describeServingLane(
			{
				id: BASE,
				endpoints: [
					{ type: "openai", baseURL: GATEWAY },
					{ type: "openai", baseURL: "https://router.huggingface.co/v1", modelId: "zai-org/GLM-4.5" },
				],
			},
			GATEWAY,
			"publicai"
		);
		expect(baseHost).toBe("api-internal.publicai.co");
		expect(resolvedModelId).toBe(`${BASE}:publicai`);
	});

	it("names the agent service's host, and pins the id since an agent lane carries no modelId", () => {
		const { baseHost, resolvedModelId } = describeServingLane(
			{ id: "potluck-agent", endpoints: [{ type: "agent", baseURL: "https://agent.fly.dev" }] },
			GATEWAY,
			"publicai"
		);
		expect(baseHost).toBe("agent.fly.dev");
		expect(resolvedModelId).toBe("potluck-agent:publicai");
	});

	it("falls back to the global base URL only when the model carries no endpoint at all", () => {
		expect(describeServingLane({ id: BASE }, GATEWAY, undefined).baseHost).toBe(
			"api-internal.publicai.co"
		);
		expect(describeServingLane({ id: BASE, endpoints: [] }, GATEWAY, undefined).baseHost).toBe(
			"api-internal.publicai.co"
		);
	});

	it("drops only baseHost on a malformed URL — the rest of the log line survives", () => {
		const { baseHost, resolvedModelId } = describeServingLane(
			{ id: BASE, endpoints: [{ type: "openai", baseURL: "not-a-url" }] },
			GATEWAY,
			"publicai"
		);
		expect(baseHost).toBeNull();
		expect(resolvedModelId).toBe(`${BASE}:publicai`);
	});

	it("returns a null host, not a crash, when nothing configures a base URL", () => {
		expect(describeServingLane({ id: BASE }, undefined, undefined).baseHost).toBeNull();
	});
});

describe("resolveClassifierLane — the search classifier follows the model serving the turn", () => {
	/** A registration carrying its OWN lane — own host, own key (by env var name), own wire id. `maybeAddCompareModels`
	 *  builds the first two today; a MODELS override supplies the third. A per-request model swap
	 *  is the shape this exercises. */
	const ownLaneModel = {
		id: "own-lane-model",
		endpoints: [{ type: "openai", baseURL: OWN_HOST, apiKeyEnv: "OWN_KEY", modelId: OWN_WIRE_ID }],
	};
	/** What modelsCatalog builds for everything else: global base, NO key, NO lane id (:120-122). */
	const catalogModel = { id: BASE, endpoints: [{ type: "openai", baseURL: GATEWAY }] };

	it("sends the SERVING model's own host, key and wire id — not the gateway the default lives on", () => {
		// The bug: the classifier read defaultModel.id + config.OPENAI_BASE_URL, so a turn's content
		// came from one host while its search decision was made by another model on the gateway.
		// Nothing errored — both globals were stale together, so the request was coherent and wrong.
		const lane = resolveClassifierLane(ownLaneModel, GATEWAY, "publicai");
		expect(lane.baseURL).toBe(OWN_HOST);
		expect(lane.apiKey).toBe("own-key");
		expect(lane.modelId).toBe(OWN_WIRE_ID);
	});

	it("suppresses global-lane headers on an own lane — the Authorization override would 401 it", () => {
		// ownLane is not cosmetic. USE_USER_TOKEN puts `Authorization: Bearer <user HF token>` on the
		// request, which REPLACES the endpoint's own key. Against a direct host that 401s, and the classifier
		// fails closed silently — the turn just stops searching, with no error anyone sees.
		expect(resolveClassifierLane(ownLaneModel, GATEWAY, "publicai").ownLane).toBe(true);
		expect(resolveClassifierLane(catalogModel, GATEWAY, "publicai").ownLane).toBe(false);
	});

	it("leaves an ordinary catalog model exactly where it was — global base, global key, pinned id", () => {
		const lane = resolveClassifierLane(catalogModel, GATEWAY, "publicai");
		expect(lane.baseURL).toBe(GATEWAY);
		expect(lane.apiKey).toBeUndefined(); // caller falls back to OPENAI_API_KEY/HF_TOKEN, as before
		expect(lane.modelId).toBe(`${BASE}:publicai`);
	});

	it("does NOT pin a provider on an own lane — `:publicai` is an HF-router suffix, not a model name", () => {
		const keyed = { id: BASE, endpoints: [{ type: "openai", baseURL: OWN_HOST, apiKeyEnv: "OWN_KEY" }] };
		expect(resolveClassifierLane(keyed, GATEWAY, "publicai").modelId).toBe(BASE);
	});

	it("falls back to the global lane for an agent endpoint — it cannot answer a logprob call", () => {
		const agent = {
			id: "potluck-agent",
			endpoints: [{ type: "agent", baseURL: "https://agent.example/v1", apiKeyEnv: "OWN_KEY" }],
		};
		const lane = resolveClassifierLane(agent, GATEWAY, "publicai");
		expect(lane.baseURL).toBe(GATEWAY);
		expect(lane.apiKey).toBeUndefined();
		expect(lane.ownLane).toBe(false);
	});

	it("treats a blank lane key as no key — whitespace must not read as its own credentials", () => {
		const blank = { id: BASE, endpoints: [{ type: "openai", baseURL: GATEWAY, apiKeyEnv: "BLANK_KEY" }] };
		expect(resolveClassifierLane(blank, GATEWAY, "publicai").ownLane).toBe(false);
	});

	it("survives an undefined model — a classifier call must never crash the turn", () => {
		const lane = resolveClassifierLane(undefined, GATEWAY, "publicai");
		expect(lane.baseURL).toBe(GATEWAY);
		expect(lane.ownLane).toBe(false);
	});
});

// Who receives a GLM call's text is a decision recorded in HF_PROVIDER_PIN, never the router's per-request
// pick. "auto" and the OPENAI_PROVIDER default both exist to steer Apertus, so neither may unpin GLM.
describe("wireModelId pins a table model on every HF-router call, whatever the caller asked", () => {
	const HF = "https://router.huggingface.co/v1";
	const wire = (over: Partial<Parameters<typeof wireModelId>[0]>) =>
		wireModelId({
			baseModelId: "zai-org/GLM-5.3",
			provider: undefined,
			defaultProvider: undefined,
			baseURL: HF,
			...over,
		});

	it("refuses an unpinned GLM id with no provider, with auto, and over the default pin (CUR-2112)", () => {
		expect(() => wire({})).toThrow(/zai-org\/GLM-5\.3 has no HF provider pin/);
		expect(() => wire({ provider: "auto" })).toThrow(/no HF provider pin/);
		expect(() => wire({ defaultProvider: "publicai" })).toThrow(/no HF provider pin/);
		expect(() => wire({ laneModelId: "zai-org/GLM-5.3" })).toThrow(/no HF provider pin/);
	});

	it("pins GLM-5.2-FP8 to zai-org, the known exception until CUR-2321", () => {
		expect(wire({ baseModelId: "zai-org/GLM-5.2-FP8", provider: "auto" })).toBe("zai-org/GLM-5.2-FP8:zai-org");
	});

	it("pins GLM-5.2 to scaleway, the EU provider chosen on terms", () => {
		expect(wire({ baseModelId: "zai-org/GLM-5.2", provider: "auto" })).toBe("zai-org/GLM-5.2:scaleway");
	});

	it("pins the second-opinion panel's Qwen to scaleway and Gemma to featherless-ai, never the router's pick (CUR-2599)", () => {
		expect(wire({ baseModelId: "Qwen/Qwen3.6-35B-A3B", provider: "auto" })).toBe("Qwen/Qwen3.6-35B-A3B:scaleway");
		expect(wire({ baseModelId: "Qwen/Qwen3.6-35B-A3B", defaultProvider: "publicai" })).toBe(
			"Qwen/Qwen3.6-35B-A3B:scaleway"
		);
		expect(wire({ baseModelId: "google/gemma-4-31B-it", provider: "auto" })).toBe(
			"google/gemma-4-31B-it:featherless-ai"
		);
		expect(wire({ laneModelId: "google/gemma-4-31B-it" })).toBe("google/gemma-4-31B-it:featherless-ai");
	});

	it("lets an explicit provider win", () => {
		expect(wire({ provider: "baseten" })).toBe("zai-org/GLM-5.3:baseten");
	});

	it("pins a lane modelId too, and leaves one that already names a provider alone", () => {
		expect(wire({ laneModelId: "zai-org/GLM-5.2" })).toBe("zai-org/GLM-5.2:scaleway");
		expect(wire({ laneModelId: "zai-org/GLM-5.3:scaleway" })).toBe("zai-org/GLM-5.3:scaleway");
	});

	it("changes nothing off the HF router, or for a model the table does not list", () => {
		expect(wire({ baseURL: GATEWAY })).toBe("zai-org/GLM-5.3");
		expect(wire({ baseModelId: "zai-org/GLM-5.2", baseURL: GATEWAY })).toBe("zai-org/GLM-5.2");
		expect(wire({ baseModelId: "openai/gpt-oss-120b", provider: "auto" })).toBe("openai/gpt-oss-120b");
		expect(wire({ baseModelId: BASE, baseURL: GATEWAY, defaultProvider: "publicai" })).toBe(
			`${BASE}:publicai`
		);
		expect(wire({ baseModelId: BASE, baseURL: GATEWAY, provider: "auto", defaultProvider: "publicai" })).toBe(
			BASE
		);
	});
});

describe("describeServingLane never throws over an unpinned GLM id (CUR-2112)", () => {
	it("reports the bare id, leaving the refusal to the call itself", () => {
		const glm = { id: "zai-org/GLM-5.3", endpoints: [{ type: "openai", baseURL: "https://router.huggingface.co/v1" }] };
		expect(describeServingLane(glm, GATEWAY, "publicai")).toEqual({
			baseHost: "router.huggingface.co",
			resolvedModelId: "zai-org/GLM-5.3",
		});
	});
});
