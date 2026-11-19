import { describe, it, expect, vi, beforeEach } from "vitest";
import { PICKER } from "../../../../config/inference";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const { pickerSpec } = await import("./primaryModel");

describe("pickerSpec", () => {
	beforeEach(() => {
		for (const k of Object.keys(cfg)) delete cfg[k];
	});

	it("serves www the file's production list even when Doppler's MODEL_ALLOWLIST says otherwise", () => {
		cfg.MODEL_ALLOWLIST = "swiss-ai/apertus-v1.5-70b";
		expect(pickerSpec({ VERCEL_ENV: "production" })).toBe(PICKER.production.join(","));
		expect(warn).toHaveBeenCalledOnce();
	});

	it("serves a preview develop's list and an event instance its own", () => {
		expect(pickerSpec({ VERCEL_ENV: "preview", INSTANCE: "mozfest" })).toBe(PICKER.develop.join(","));
		expect(pickerSpec({ VERCEL_ENV: "production", INSTANCE: "lugano" })).toBe(PICKER.lugano.join(","));
	});

	it("keeps MODEL_ALLOWLIST as the override off Vercel, so an eval still pins one model", () => {
		cfg.MODEL_ALLOWLIST = "zai-org/GLM-5.2";
		expect(pickerSpec({})).toBe("zai-org/GLM-5.2");
	});

	it("a self-host in production mode (ALPHA_EDITION=selfhost) keeps its own MODEL_ALLOWLIST, never our picker", () => {
		cfg.MODEL_ALLOWLIST = "qwen2.5-0.5b-instruct";
		expect(pickerSpec({ DEPLOY_ENV: "production", ALPHA_EDITION: "selfhost" })).toBe("qwen2.5-0.5b-instruct");
		expect(pickerSpec({ DEPLOY_ENV: "production", ALPHA_EDITION: "hosted" })).toBe(PICKER.production.join(","));
	});

	it("returns empty off Vercel with nothing set, leaving the default to models.ts as before", () => {
		expect(pickerSpec({})).toBe("");
	});
});
