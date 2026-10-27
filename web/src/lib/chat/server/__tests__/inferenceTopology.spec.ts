import { describe, expect, it, vi } from "vitest";
import {
	checkRoles,
	describeRoles,
	shadowedIds,
	topologyFromRegistry,
	uncheckedProviders,
	type Lane,
	type RegistryEntry,
} from "../inferenceTopology";

const GATEWAY = "https://api-internal.publicai.co/v1";
const HF = "https://router.huggingface.co/v1";
const COMPARE = "https://compare.example/v1";

const lanes: Lane[] = [
	{ name: "gateway", baseURL: GATEWAY, keyEnv: "OPENAI_API_KEY", listsModels: true, apiKey: "k1" },
	{ name: "backup", baseURL: HF, keyEnv: "HF_TOKEN", listsModels: true, apiKey: "k2" },
	{ name: "compare", baseURL: COMPARE, keyEnv: "SECOND_OPINION_API_KEY", listsModels: false },
];

function registry(backupBase: string, backupModel: string): RegistryEntry[] {
	return [
		{
			id: "swiss-ai/apertus-v1.5-70b",
			endpoints: [{ baseURL: GATEWAY }, { baseURL: backupBase, modelId: backupModel }],
		},
		{ id: "mistral-small", unlisted: true, endpoints: [{ baseURL: COMPARE }] },
	];
}

const roles = { defaultChat: "swiss-ai/apertus-v1.5-70b", task: "mistral-small", comparePanel: ["mistral-small"] };
const gatewayKnown = new Map([["gateway", new Set(["swiss-ai/apertus-v1.5-70b", "swiss-ai/apertus-v1.5-70b-thinking"])]]);

describe("inference topology from the registry", () => {
	it("fails the fallback role loud when HF does not list prd's old FALLBACK_MODEL_ID (CUR-2293)", async () => {
		const cfg = topologyFromRegistry(registry(HF, "swiss-ai/Apertus-v1.5-70B"), lanes, roles, "production");
		const fetchIds = vi.fn(async () => ["swiss-ai/Apertus-8B-Instruct-2509", "zai-org/GLM-5.3"]);
		const { unserved } = await checkRoles(cfg, lanes, gatewayKnown, fetchIds);
		expect(unserved).toEqual([
			{
				role: "fallback",
				model: "backup:swiss-ai/apertus-v1.5-70b",
				provider: "backup",
				upstream: "swiss-ai/Apertus-v1.5-70B",
				reason: "absent",
			},
		]);
		expect(fetchIds).toHaveBeenCalledWith(HF, "k2");
	});

	it("checks a backup on the gateway's own host against the list already fetched, with no second fetch", async () => {
		const cfg = topologyFromRegistry(
			registry(GATEWAY, "swiss-ai/apertus-v1.5-70b-thinking"),
			lanes,
			roles,
			"production"
		);
		const fetchIds = vi.fn(async () => []);
		const { unserved } = await checkRoles(cfg, lanes, gatewayKnown, fetchIds);
		expect(unserved).toEqual([]);
		expect(fetchIds).not.toHaveBeenCalled();
		expect(describeRoles(cfg)).toContain(
			"fallback=backup:swiss-ai/apertus-v1.5-70b@gateway[api-internal.publicai.co] (sent as swiss-ai/apertus-v1.5-70b-thinking)"
		);
	});

	it("reports the role unread, never served, when the backup's /models cannot be read", async () => {
		const cfg = topologyFromRegistry(registry(HF, "zai-org/GLM-5.3"), lanes, roles, "develop");
		const { unserved, fetchErrors } = await checkRoles(cfg, lanes, gatewayKnown, async () => {
			throw new Error("503 from https://router.huggingface.co/v1/models");
		});
		expect(unserved.map((r) => [r.role, r.reason])).toEqual([["fallback", "unread"]]);
		expect(fetchErrors).toEqual({ backup: "503 from https://router.huggingface.co/v1/models" });
	});

	it("a /models that times out at boot yields one unchecked-roles warning naming the provider, host, error and role, never an absent role (CUR-4057)", async () => {
		const cfg = topologyFromRegistry(registry(HF, "zai-org/GLM-5.3"), lanes, roles, "develop");
		const { unserved, fetchErrors } = await checkRoles(cfg, lanes, gatewayKnown, async () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		});
		expect(unserved.filter((r) => r.reason === "absent")).toEqual([]);
		const [p, ...rest] = uncheckedProviders(cfg, unserved, fetchErrors);
		expect(rest).toEqual([]);
		expect(p).toMatchObject({ provider: "backup", host: HF, reason: "timeout", unchecked: ["fallback=zai-org/GLM-5.3"] });
		expect(p.message).toBe(
			"[inference] could not read backup's model list at boot (https://router.huggingface.co/v1/models: The operation was aborted due to timeout), so 1 role was not checked: fallback=zai-org/GLM-5.3"
		);
	});

	it("groups unread roles one line per provider and tells a non-2xx answer from an unreachable host (CUR-4057)", () => {
		const cfg = topologyFromRegistry(registry(HF, "zai-org/GLM-5.3"), lanes, roles, "develop");
		const unread = (role: string, provider: string, upstream: string) =>
			({ role, model: upstream, provider, upstream, reason: "unread" }) as const;
		const out = uncheckedProviders(
			cfg,
			[
				unread("fallback", "backup", "zai-org/GLM-5.3"),
				unread("compare_panel", "backup", "zai-org/GLM-5.2"),
				unread("task", "gateway", "mistral-small"),
				{ role: "aggregator", model: "x", provider: "gateway", upstream: "x", reason: "absent" },
			] as Parameters<typeof uncheckedProviders>[1],
			{ backup: "503 from https://router.huggingface.co/v1/models", gateway: "fetch failed" }
		);
		expect(out.map((p) => [p.provider, p.reason, p.unchecked])).toEqual([
			["backup", "non-ok", ["fallback=zai-org/GLM-5.3", "compare_panel=zai-org/GLM-5.2"]],
			["gateway", "unreachable", ["task=mistral-small"]],
		]);
		expect(out[0].message).toContain("so 2 roles were not checked");
	});

	it("throws when a role names a model the registry never registered", () => {
		expect(() =>
			topologyFromRegistry(registry(HF, "zai-org/GLM-5.3"), lanes, { ...roles, arithmeticRoute: "not-registered" }, "develop")
		).toThrow(/role arithmetic_route names not-registered/);
	});

	it("names an endpoint on no declared lane by its host, and never checks it", async () => {
		const reg = [...registry(HF, "zai-org/GLM-5.3"), { id: "stray", endpoints: [{ baseURL: "https://elsewhere.example/v1" }] }];
		const cfg = topologyFromRegistry(reg, lanes, { ...roles, aggregator: "stray" }, "develop");
		expect(cfg.providers.find((p) => p.name === "elsewhere.example")).toMatchObject({ lists_models: false });
		const { unserved } = await checkRoles(cfg, lanes, gatewayKnown, async () => ["zai-org/GLM-5.3"]);
		expect(unserved).toEqual([]);
	});
});

describe("a model id registered twice (CUR-2277, develop's Bielik)", () => {
	const twice: RegistryEntry[] = [
		...registry(HF, "swiss-ai/Apertus-v1.5-70B"),
		{ id: "speakleash/Bielik-11B-v3.0-Instruct", endpoints: [{ baseURL: GATEWAY }] },
		{ id: "speakleash/Bielik-11B-v3.0-Instruct", endpoints: [{ baseURL: COMPARE }] },
	];

	it("builds the config from the first registration, the one the app serves, instead of rejecting every role", () => {
		const cfg = topologyFromRegistry(twice, lanes, roles, "develop");
		const bielik = cfg.model_list.filter((m) => m.model_name === "speakleash/Bielik-11B-v3.0-Instruct");
		expect(bielik).toHaveLength(1);
		expect(bielik[0].litellm_params.provider).toBe("gateway");
	});

	it("names the shadowed id so boot can warn about the dead registration", () => {
		expect(shadowedIds(twice)).toEqual(["speakleash/Bielik-11B-v3.0-Instruct"]);
		expect(shadowedIds(registry(HF, "x"))).toEqual([]);
	});
});
