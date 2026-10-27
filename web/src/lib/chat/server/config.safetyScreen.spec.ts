// The Zentropi judge's committed config (web/config/safetyScreen.ts). Lives under src/ because
// vitest collects no spec from web/config/. (CUR-4340)
import { describe, expect, it } from "vitest";
import { ZENTROPI_JUDGE, parseZentropiJudgeConfig } from "../../../../config/safetyScreen";

describe("web/config/safetyScreen.ts (CUR-4340)", () => {
	it("parses the committed Zentropi judge config: an https api_base, an env var NAME for the key, a model, a positive timeout, a non-empty language map", () => {
		const cfg = parseZentropiJudgeConfig(ZENTROPI_JUDGE);
		expect(new URL(cfg.provider.api_base).protocol).toBe("https:");
		expect(cfg.provider.api_key_env).toBe("HF_TOKEN");
		expect(cfg.model).toBe("zentropi-ai/cope-b-a4b");
		expect(cfg.timeoutMs).toBe(5000);
		expect(cfg.routedLanguages).toEqual({ amh: "am", yor: "yo", hau: "ha", swh: "sw" });
	});

	it("refuses a literal key in api_key_env, so a key can never be committed in its place", () => {
		const leaked = { ...ZENTROPI_JUDGE, provider: { ...ZENTROPI_JUDGE.provider, api_key_env: "zt_abc123" } };
		expect(() => parseZentropiJudgeConfig(leaked)).toThrow(/api_key_env names an env var/);
	});

	it("refuses an empty language map, a zero timeout and a non-URL api_base", () => {
		expect(() => parseZentropiJudgeConfig({ ...ZENTROPI_JUDGE, routedLanguages: {} })).toThrow();
		expect(() => parseZentropiJudgeConfig({ ...ZENTROPI_JUDGE, timeoutMs: 0 })).toThrow();
		expect(() =>
			parseZentropiJudgeConfig({ ...ZENTROPI_JUDGE, provider: { ...ZENTROPI_JUDGE.provider, api_base: "zentropi" } })
		).toThrow();
	});
});
