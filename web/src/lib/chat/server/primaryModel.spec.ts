import { describe, it, expect, vi, beforeEach } from "vitest";
import { PICKER } from "../../../../config/inference";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const { pickerSpec } = await import("./primaryModel");

describe("pickerSpec (CUR-3484)", () => {
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

	it("returns empty off Vercel with nothing set, leaving the default to models.ts as before", () => {
		expect(pickerSpec({})).toBe("");
	});
});
