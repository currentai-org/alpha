// The safety judges' committed config (web/config/safetyScreen.ts). Lives under src/ because
// vitest collects no spec from web/config/.
import { describe, expect, it } from "vitest";
import { MILA_SP_GUARD, S1_JUDGE, parseS1JudgeConfig } from "../../../../config/safetyScreen";
import { judgeApiBase } from "./detectors/judgeApiBase";

// The addresses every production and preview deployment called before the endpoints moved behind env
// vars, copied from the file as it stood (develop d04da6fd), not from the constants under test.
const ADDRESSES_BEFORE = {
	s1: "https://6ada5fa5a0e732657786181a.endpoints.huggingface.cloud",
	milaSp: "https://6ae4cc0afef6e9d4f6123fcd.endpoints.huggingface.cloud",
};
const JUDGES = [
	["S1", S1_JUDGE.provider, "ZENTROPI_S1_ENDPOINT_URL", ADDRESSES_BEFORE.s1],
	["Mila SP", MILA_SP_GUARD.provider, "MILA_SP_ENDPOINT_URL", ADDRESSES_BEFORE.milaSp],
] as const;

// The provider rules every judge's config shares, checked through S1's parser.
describe("web/config/safetyScreen.ts: a judge provider", () => {
	it("refuses a literal key in api_key_env, so a key can never be committed in its place", () => {
		const leaked = { ...S1_JUDGE, provider: { ...S1_JUDGE.provider, api_key_env: "hf_abc123" } };
		expect(() => parseS1JudgeConfig(leaked)).toThrow(/api_key_env names an env var/);
	});

	it("refuses a URL in api_base_env, so an address is never mistaken for the name of its env var", () => {
		const swapped = { ...S1_JUDGE, provider: { ...S1_JUDGE.provider, api_base_env: "https://s1.example" } };
		expect(() => parseS1JudgeConfig(swapped)).toThrow(/api_base_env names an env var/);
	});

	it("refuses a non-URL deployed_api_base", () => {
		expect(() => parseS1JudgeConfig({ ...S1_JUDGE, provider: { ...S1_JUDGE.provider, deployed_api_base: "s1" } })).toThrow();
	});
});

// A self-host holds an HF_TOKEN for its own reasons. Before the endpoint had an env var, that token alone
// made every judge look configured and call Current AI's own endpoints, which it cannot use.
describe("judgeApiBase: where each safety judge's endpoint comes from", () => {
	it.each(JUDGES)(
		"%s: production resolves the same endpoint it called before the env var existed, with the var unset",
		(_name, provider, _var, before) => {
			expect(judgeApiBase(provider, { DEPLOY_ENV: "production", HF_TOKEN: "hf_x" })).toBe(before);
			// Vercel production sets VERCEL_ENV, not DEPLOY_ENV.
			expect(judgeApiBase(provider, { VERCEL_ENV: "production" })).toBe(before);
		}
	);

	it.each(JUDGES)(
		"%s: preview resolves the same endpoint it called before the env var existed, with the var unset",
		(_name, provider, _var, before) => {
			expect(judgeApiBase(provider, { DEPLOY_ENV: "preview" })).toBe(before);
			expect(judgeApiBase(provider, { VERCEL_ENV: "preview" })).toBe(before);
		}
	);

	it.each(JUDGES)(
		"%s: has no endpoint without its env var off production and preview, even with HF_TOKEN set",
		(_name, provider) => {
			for (const env of [
				{ HF_TOKEN: "hf_selfhost" },
				{ HF_TOKEN: "hf_selfhost", DEPLOY_ENV: "development" },
				{ HF_TOKEN: "hf_selfhost", DEPLOY_ENV: "staging" },
				{ HF_TOKEN: "hf_selfhost", VERCEL_ENV: "development" },
				// A self-host in production mode is not one of our deployments.
				{ HF_TOKEN: "hf_selfhost", DEPLOY_ENV: "production", ALPHA_EDITION: "selfhost" },
			])
				expect(judgeApiBase(provider, env)).toBeUndefined();
		}
	);

	it.each(JUDGES)("%s: its env var names the endpoint on any deployment, production included", (_name, provider, envVar) => {
		expect(provider.api_base_env).toBe(envVar);
		for (const deploy of [{}, { DEPLOY_ENV: "production" }, { DEPLOY_ENV: "preview" }])
			expect(judgeApiBase(provider, { ...deploy, [envVar]: "  https://judge.selfhost.example/  " })).toBe(
				"https://judge.selfhost.example"
			);
	});

	it.each(JUDGES)("%s: a blank env var is unset, not an empty address", (_name, provider, envVar) => {
		expect(judgeApiBase(provider, { [envVar]: "  " })).toBeUndefined();
		expect(judgeApiBase(provider, { [envVar]: "", DEPLOY_ENV: "production" })).toBe(provider.deployed_api_base);
	});
});
