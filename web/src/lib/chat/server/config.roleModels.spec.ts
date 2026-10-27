import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_MODELS, roleModelSetting } from "../../../../config/inference";

// CUR-2277 phase 2: a role's model is committed in config/inference.ts. config.ts snapshots the env at
// import, so each case mocks it and imports a fresh copy.
const env = vi.hoisted(() => ({ server: {} as Record<string, string> }));
vi.mock("$env/dynamic/public", () => ({ env: {} }));
vi.mock("$env/dynamic/private", () => ({ env: env.server }));
vi.mock("$app/environment", () => ({ building: false }));

async function configWith(vars: Record<string, string>) {
	for (const k of Object.keys(env.server)) delete env.server[k];
	Object.assign(env.server, vars);
	vi.resetModules();
	return (await import("./config")).config;
}

afterEach(() => vi.resetModules());

describe("role models on a deployment come from config/inference.ts, never the env var", () => {
	it.each([
		[{ VERCEL_ENV: "production" }],
		[{ VERCEL_ENV: "preview" }],
		[{ DEPLOY_ENV: "preview" }],
	])("ignores a TASK_MODEL env value that disagrees (%o)", async (deploy) => {
		const config = await configWith({ ...deploy, TASK_MODEL: "typo/model" });
		expect(config.TASK_MODEL).toBe(ROLE_MODELS.TASK_MODEL);
	});

	it("serves the committed value when the env var is unset", async () => {
		const config = await configWith({ VERCEL_ENV: "production" });
		expect(config.ARITHMETIC_ROUTE_MODEL).toBe(ROLE_MODELS.ARITHMETIC_ROUTE_MODEL);
		expect(config.FALLBACK_MODEL_ID).toBe(ROLE_MODELS.FALLBACK_MODEL_ID);
	});

	it("serves COMPARE_PANEL as the comma-joined string its readers split", async () => {
		const config = await configWith({ VERCEL_ENV: "preview" });
		expect(config.COMPARE_PANEL).toBe(ROLE_MODELS.COMPARE_PANEL.join(","));
		expect(roleModelSetting("COMPARE_PANEL").split(",")).toEqual([...ROLE_MODELS.COMPARE_PANEL]);
	});

	it("leaves keys that are not roles to the env", async () => {
		const config = await configWith({ VERCEL_ENV: "production", OPENAI_BASE_URL: "https://example.test/v1" });
		expect(config.OPENAI_BASE_URL).toBe("https://example.test/v1");
	});
});

describe("off Vercel the env var alone decides, so local dev and evals name their own models", () => {
	it("returns the env value", async () => {
		const config = await configWith({ TASK_MODEL: "mistral-large-2512" });
		expect(config.TASK_MODEL).toBe("mistral-large-2512");
	});

	it("returns empty, not the committed model, when the env var is unset", async () => {
		const config = await configWith({});
		expect(config.TASK_MODEL).toBe("");
	});
});
