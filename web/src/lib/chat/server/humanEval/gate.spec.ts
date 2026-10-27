import { afterEach, describe, expect, it, vi } from "vitest";
import { includeDraftLanguages } from "./gate";

describe("includeDraftLanguages", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		["preview", true],
		["development", true],
		["production", false],
	])("opens draft languages on %s: %s", (env, open) => {
		vi.stubEnv("DEPLOY_ENV", env);
		expect(includeDraftLanguages()).toBe(open);
	});

	it("keeps drafts closed (fail closed) when no environment is declared", () => {
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "");
		expect(includeDraftLanguages()).toBe(false);
	});
});
