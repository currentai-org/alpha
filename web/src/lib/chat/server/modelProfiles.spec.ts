import { describe, it, expect } from "vitest";
import { rolesNeedFlattening, HF_PROVIDER_PIN, acceptedEffort, measuredReasoningOff, reasoningOffFields, splitWireId } from "./modelProfiles";
import { replyLanguageRuleFits } from "./harnessProfiles";
import verified from "./modelProfiles.verified.json";

const HF = "https://router.huggingface.co/v1";

describe("reasoningOffFields is keyed by model AND provider, not provider alone", () => {
	it("turns GLM-5.2 off with reasoning_effort on scaleway and on deepinfra", () => {
		expect(reasoningOffFields("zai-org/GLM-5.2", "scaleway")).toEqual({ reasoning_effort: "none" });
		expect(reasoningOffFields("zai-org/GLM-5.2", "deepinfra")).toEqual({ reasoning_effort: "none" });
	});

	it("turns GLM-5.3 off with thinking on novita, where reasoning_effort is ignored", () => {
		expect(reasoningOffFields("zai-org/GLM-5.3", "novita")).toEqual({ thinking: { type: "disabled" } });
	});

	it("sends nothing for a measured pair with no switch, rather than a field the probe saw ignored", () => {
		expect(reasoningOffFields("openai/gpt-oss-120b", "scaleway")).toEqual({});
	});

	it("falls back to thinking disabled for a pair nobody measured", () => {
		expect(reasoningOffFields("zai-org/GLM-5.3", "baseten")).toEqual({ thinking: { type: "disabled" } });
		expect(reasoningOffFields("zai-org/GLM-5.2-FP8", undefined)).toEqual({ thinking: { type: "disabled" } });
	});
});

describe("measuredReasoningOff sends only a measured switch, never the thinking guess", () => {
	const STG = "https://router.stg.aipotluck.org/v1";

	it("turns Large 4 off with reasoning_effort none on the staging router (CUR-4281)", () => {
		expect(measuredReasoningOff("mistralai/mistral-large-2610", STG)).toEqual({ reasoning_effort: "none" });
	});

	it("sends nothing for a pair nobody measured, since thinking disabled hangs the staging router", () => {
		expect(measuredReasoningOff("mistralai/mistral-large-2512", STG)).toEqual({});
		expect(measuredReasoningOff("zai-org/GLM-5.3", "https://example.test/v1")).toEqual({});
	});

	it("reads a :provider suffix before the host, as reasoningOffFields does", () => {
		expect(measuredReasoningOff("zai-org/GLM-5.2:scaleway", HF)).toEqual({ reasoning_effort: "none" });
	});
});

describe("every pinned provider has a verified profile row", () => {
	it("fails when a pin names a provider no probe has measured for that model", () => {
		for (const [model, provider] of Object.entries(HF_PROVIDER_PIN)) {
			const rows = (verified as Record<string, Record<string, unknown>>)[model];
			expect(rows?.[provider], `${model}:${provider}`).toBeDefined();
		}
	});
});

describe("acceptedEffort never sends an effort the serving pair rejects", () => {
	it("raises none to the lowest accepted effort for gpt-oss, pinned or routed", () => {
		expect(acceptedEffort("openai/gpt-oss-120b:scaleway", HF, "none")).toBe("low");
		expect(acceptedEffort("openai/gpt-oss-120b", HF, "none")).toBe("low");
	});

	it("keeps an effort the pair accepts, and leaves an unset effort unset", () => {
		expect(acceptedEffort("openai/gpt-oss-120b", HF, "high")).toBe("high");
		expect(acceptedEffort("zai-org/GLM-5.2:scaleway", HF, "none")).toBe("none");
		expect(acceptedEffort("openai/gpt-oss-120b", HF, undefined)).toBeUndefined();
	});

	it("passes the wanted effort through for a model with no rows", () => {
		expect(acceptedEffort("allenai/Olmo-3-32B-Think", HF, "none")).toBe("none");
	});

	it("reads a gateway pair's row by host when the id carries no provider", () => {
		expect(
			acceptedEffort("swiss-ai/Apertus-v1.5-70B", "https://api.infomaniak.com/v1", "none")
		).toBe("none");
	});
});

describe("splitWireId", () => {
	it("splits on the last colon and lower-cases the provider", () => {
		expect(splitWireId("zai-org/GLM-5.2:Scaleway")).toEqual({
			model: "zai-org/GLM-5.2",
			provider: "scaleway",
		});
		expect(splitWireId("zai-org/GLM-5.2")).toEqual({ model: "zai-org/GLM-5.2", provider: undefined });
	});
});

describe("rolesNeedFlattening (CUR-2145)", () => {
	it("keeps flattening Apertus 70B, the prod default, because Featherless refuses the system role", () => {
		expect(rolesNeedFlattening("swiss-ai/apertus-v1.5-70b")).toBe(true);
		expect(rolesNeedFlattening("swiss-ai/Apertus-v1.5-70B")).toBe(true);
	});

	it("stops flattening a model every measured lane serves with roles, with or without a provider suffix", () => {
		expect(rolesNeedFlattening("zai-org/GLM-5.3")).toBe(false);
		expect(rolesNeedFlattening("zai-org/GLM-5.2:scaleway")).toBe(false);
	});

	it("stops flattening Mistral Large 3, develop's default, whose probe row follows the system role 3/3 (CUR-2330)", () => {
		expect(rolesNeedFlattening("mistral-large-2512")).toBe(false);
	});

	it("sends Mistral Large 3 no reasoning-off field: its API answers 422 to `thinking` and 400 to any effort (CUR-2330)", () => {
		expect(reasoningOffFields("mistral-large-2512", "gateway:api.mistral.ai")).toEqual({});
	});

	it("sends a non-Apertus model nobody has measured its real roles, e.g. the gateway's Sea-Lion and Bielik", () => {
		expect(rolesNeedFlattening("some-org/never-probed-model")).toBe(false);
		expect(rolesNeedFlattening("aisingapore/Qwen-SEA-LION-v4-32B-IT")).toBe(false);
		expect(rolesNeedFlattening("speakleash/Bielik-11B-v3.0-Instruct")).toBe(false);
	});

	it("flattens an unprobed Apertus model whose harness row says so, since it can land on the same refusing hosts", () => {
		expect(rolesNeedFlattening("swiss-ai/apertus-v1.5-70b-thinking")).toBe(true);
		expect(rolesNeedFlattening("swiss-ai/Apertus-8B-Instruct:publicai")).toBe(true);
	});

	it("does not flatten an Apertus id with no harness row: rows are exact, so a name that only looks like Apertus gets nothing (CUR-2697)", () => {
		expect(rolesNeedFlattening("swiss-ai/apertus-70b-instruct")).toBe(false);
		expect(rolesNeedFlattening("swiss-ai/Apertus-v1.5-8B-Thinking")).toBe(false);
	});
});

describe("replyLanguageRuleFits (CUR-2294)", () => {
	it("withholds the reply-language sentence from Mistral Large 3, however the id is spelled on the wire", () => {
		for (const id of ["mistral-large-2512", "Mistral-Large-2512", "mistral-large-2512:mistral"]) {
			expect(replyLanguageRuleFits(id), id).toBe(false);
		}
	});

	it("withholds it from mistral-small-2603, the plan model that writes the prose under a checked ledger (CUR-2530)", () => {
		for (const id of ["mistral-small-2603", "Mistral-Small-2603", "mistral-small-2603:mistral"]) {
			expect(replyLanguageRuleFits(id), id).toBe(false);
		}
	});

	it("keeps the sentence for Apertus and for a model with no measured misfire", () => {
		for (const id of ["swiss-ai/apertus-v1.5-70b", "swiss-ai/apertus-v1.5-8b", "zai-org/GLM-5.3", undefined]) {
			expect(replyLanguageRuleFits(id), String(id)).toBe(true);
		}
	});
});
