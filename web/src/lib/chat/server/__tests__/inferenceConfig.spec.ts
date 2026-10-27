import { describe, expect, it } from "vitest";
import {
	buildInferenceConfig,
	describeRoles,
	inferenceEnvironment,
	PICKER,
	pickerSite,
	pickerSites,
	unservedRoles,
	type InferenceConfigInput,
} from "../../../../../config/inference";

// Production's shape (CUR-2293): the gateway serves the default chat model, and the
// backup lane asks the HF router for FALLBACK_MODEL_ID.
function prodShape(fallbackUpstream: string): InferenceConfigInput {
	return {
		environment: "production",
		providers: [
			{ name: "gateway", api_base: "https://api-internal.publicai.co/v1", api_key_env: "OPENAI_API_KEY", lists_models: true },
			{ name: "hf", api_base: "https://router.huggingface.co/v1", api_key_env: "HF_TOKEN", lists_models: true },
			{ name: "compare", api_base: "https://compare.example/v1", api_key_env: "SECOND_OPINION_API_KEY", lists_models: false },
		],
		model_list: [
			{ model_name: "swiss-ai/apertus-v1.5-70b", litellm_params: { model: "swiss-ai/apertus-v1.5-70b", provider: "gateway" } },
			{ model_name: "backup", litellm_params: { model: fallbackUpstream, provider: "hf" } },
			{ model_name: "mistral-small", litellm_params: { model: "mistral-small", provider: "compare" } },
		],
		roles: { default_chat: "swiss-ai/apertus-v1.5-70b", fallback: "backup", task: "mistral-small" },
	};
}

// What `router.huggingface.co/v1/models` lists for these families (CUR-2293).
const hfServed = new Set(["swiss-ai/Apertus-8B-Instruct-2509", "zai-org/GLM-5.3", "zai-org/GLM-5.2"]);
const gatewayServed = new Set(["swiss-ai/apertus-v1.5-70b"]);

describe("inference config", () => {
	it("reports the fallback role when HF does not list prd's old FALLBACK_MODEL_ID (the CUR-2293 case)", () => {
		const cfg = buildInferenceConfig(prodShape("swiss-ai/Apertus-v1.5-70B"));
		expect(unservedRoles(cfg, new Map([["gateway", gatewayServed], ["hf", hfServed]]))).toEqual([
			{ role: "fallback", model: "backup", provider: "hf", upstream: "swiss-ai/Apertus-v1.5-70B", reason: "absent" },
		]);
	});

	it("reports nothing when every role's model is in its provider's list", () => {
		const cfg = buildInferenceConfig(prodShape("zai-org/GLM-5.3"));
		expect(unservedRoles(cfg, new Map([["gateway", gatewayServed], ["hf", hfServed]]))).toEqual([]);
	});

	it("reports a role as unread, never as served, when its provider's list could not be fetched", () => {
		const cfg = buildInferenceConfig(prodShape("zai-org/GLM-5.3"));
		expect(unservedRoles(cfg, new Map([["gateway", gatewayServed]]))).toEqual([
			{ role: "fallback", model: "backup", provider: "hf", upstream: "zai-org/GLM-5.3", reason: "unread" },
		]);
	});

	it("skips roles on a provider with no /models list rather than calling them unread", () => {
		const cfg = buildInferenceConfig(prodShape("zai-org/GLM-5.3"));
		const roles = unservedRoles(cfg, new Map([["gateway", gatewayServed], ["hf", hfServed]])).map((r) => r.role);
		expect(roles).not.toContain("task");
	});

	it("refuses a config whose role names a model that is not in model_list", () => {
		const input = prodShape("zai-org/GLM-5.3");
		input.roles.aggregator = "not-declared";
		expect(() => buildInferenceConfig(input)).toThrow(/roles\.aggregator: role aggregator names not-declared/);
	});

	it("refuses a model on an undeclared provider, and lists every problem in one throw", () => {
		const input = prodShape("zai-org/GLM-5.3");
		input.model_list.push({ model_name: "orphan", litellm_params: { model: "orphan", provider: "nowhere" } });
		input.roles.compare_panel = ["ghost"];
		expect(() => buildInferenceConfig(input)).toThrow(/provider nowhere[\s\S]*compare_panel names ghost/);
	});

	it("refuses a key value where the env var name belongs", () => {
		const input = prodShape("zai-org/GLM-5.3");
		input.providers[0].api_key_env = "the key itself";
		expect(() => buildInferenceConfig(input)).toThrow(/api_key_env names an env var/);
	});

	it("checks each compare panelist on its own", () => {
		const input = prodShape("zai-org/GLM-5.3");
		input.model_list.push({ model_name: "glm", litellm_params: { model: "zai-org/GLM-9", provider: "hf" } });
		input.roles.compare_panel = ["backup", "glm"];
		const cfg = buildInferenceConfig(input);
		expect(unservedRoles(cfg, new Map([["gateway", gatewayServed], ["hf", hfServed]]))).toEqual([
			{ role: "compare_panel", model: "glm", provider: "hf", upstream: "zai-org/GLM-9", reason: "absent" },
		]);
	});

	it("describes roles as sorted lines naming each provider's host, and the upstream id only where it differs", () => {
		const cfg = buildInferenceConfig(prodShape("zai-org/GLM-5.3"));
		expect(describeRoles(cfg)).toEqual([
			"default_chat=swiss-ai/apertus-v1.5-70b@gateway[api-internal.publicai.co]",
			"fallback=backup@hf[router.huggingface.co] (sent as zai-org/GLM-5.3)",
			"task=mistral-small@compare[compare.example]",
		]);
	});

	it("maps only Vercel production to the production overlay", () => {
		expect(inferenceEnvironment("production")).toBe("production");
		expect(inferenceEnvironment("preview")).toBe("develop");
		expect(inferenceEnvironment(undefined)).toBe("develop");
	});

	it("reports each picker entry its provider does not list, like any other role (CUR-3484)", () => {
		const input = prodShape("zai-org/GLM-5.3");
		input.model_list.push({ model_name: "gone-model", litellm_params: { model: "gone-model", provider: "gateway" } });
		input.roles.picker = ["swiss-ai/apertus-v1.5-70b", "gone-model"];
		expect(unservedRoles(buildInferenceConfig(input), new Map([["gateway", gatewayServed], ["hf", hfServed]]))).toEqual([
			{ role: "picker", model: "gone-model", provider: "gateway", upstream: "gone-model", reason: "absent" },
		]);
	});
});

describe("picker lists", () => {
	it("gives previews develop's list and www production's", () => {
		expect(pickerSite("preview", "www")).toBe("develop");
		expect(pickerSite(undefined, "www")).toBe("develop");
		expect(pickerSite("production", "www")).toBe("production");
		expect(pickerSite("production", "mozfest")).toBe("mozfest");
	});

	it("throws for an event instance with no list of its own rather than handing it www's", () => {
		expect(() => pickerSite("production", "berlin")).toThrow(/no picker list/);
	});

	it("names every site, with no site empty and no id listed twice", () => {
		for (const site of pickerSites) {
			expect(PICKER[site].length, site).toBeGreaterThan(0);
			expect(new Set(PICKER[site]).size, site).toBe(PICKER[site].length);
		}
	});
});
