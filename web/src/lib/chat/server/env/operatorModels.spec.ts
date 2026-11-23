import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyOperatorModels } from "./operatorModels";

// The file at `path`, loaded the way config.ts loads it, into a copy of `env`.
const loadOperatorModels = (path: string, env: Record<string, string | undefined>, read: (p: string) => string) =>
	applyOperatorModels({ ...env, ALPHA_MODELS_FILE: path }, read)!;

const EXAMPLE = fileURLToPath(new URL("../../../../../../selfhost/config/models.example.json", import.meta.url));
const PATH = "/config/models.json";

const file = (over: Record<string, unknown> = {}) => ({
	providers: [
		{ name: "local", api_base: "http://llama:8080/v1/", api_key_env: "OPENAI_API_KEY", lists_models: true },
		{ name: "other", api_base: "https://other.example/v1", api_key_env: "OTHER_KEY", lists_models: false },
	],
	model_list: [
		{ model_name: "small", litellm_params: { model: "small", provider: "local" } },
		{ model_name: "large", litellm_params: { model: "large", provider: "local" } },
		{ model_name: "far", litellm_params: { model: "far", provider: "other" } },
	],
	roles: { default_chat: "large", task: "small", picker: ["large", "small"] },
	...over,
});
const reader = (body: unknown) => () => (typeof body === "string" ? body : JSON.stringify(body));
const selfhost = { ALPHA_EDITION: "selfhost", DEPLOY_ENV: "production", OPENAI_API_KEY: "none" };

describe("operator model list file (ALPHA_MODELS_FILE)", () => {
	it("fails boot with the file path when a role names a model the file does not list", () => {
		const bad = file({ roles: { default_chat: "large", task: "missing-model", picker: ["large"] } });
		expect(() => loadOperatorModels(PATH, selfhost, reader(bad))).toThrow(PATH);
		expect(() => loadOperatorModels(PATH, selfhost, reader(bad))).toThrow(/role task names missing-model, which is not in model_list/);
	});

	it("replaces the env's endpoint, picker and role models with the file's, and names what it replaced", () => {
		const env: Record<string, string | undefined> = {
			...selfhost,
			ALPHA_MODELS_FILE: PATH,
			OPENAI_BASE_URL: "http://stale.example/v1",
			MODEL_ALLOWLIST: "*",
			COMPARE_PANEL: "a,b",
		};
		const loaded = applyOperatorModels(env, reader(file()));
		expect(env.OPENAI_BASE_URL).toBe("http://llama:8080/v1");
		expect(env.OPENAI_API_KEY).toBe("none");
		expect(env.MODEL_ALLOWLIST).toBe("large,small");
		expect(env.TASK_MODEL).toBe("small");
		expect(env.COMPARE_PANEL).toBe("");
		expect(loaded?.replaced.sort()).toEqual(["COMPARE_PANEL", "MODEL_ALLOWLIST", "OPENAI_BASE_URL"]);
	});

	it("offers every listed model on the default chat model's provider, default first, when the file gives no picker", () => {
		const f = file({
			model_list: file().model_list.slice(0, 2),
			providers: file().providers.slice(0, 1),
			roles: { default_chat: "large" },
		});
		expect(loadOperatorModels(PATH, selfhost, reader(f)).env.MODEL_ALLOWLIST).toBe("large,small");
	});

	it("refuses a picker model on a second provider, since Alpha serves one endpoint", () => {
		const f = file({ roles: { default_chat: "large", picker: ["large", "far"] } });
		expect(() => loadOperatorModels(PATH, selfhost, reader(f))).toThrow(/model far is on provider other/);
	});

	it("refuses a provider whose key variable is unset", () => {
		expect(() => loadOperatorModels(PATH, { ALPHA_EDITION: "selfhost" }, reader(file()))).toThrow(
			/reads its key from OPENAI_API_KEY, which is not set/
		);
	});

	it("refuses an upstream id that differs from model_name, rather than listing a name the server does not report", () => {
		const f = file({
			model_list: [{ model_name: "large", litellm_params: { model: "org/large-v2", provider: "local" } }],
			providers: file().providers.slice(0, 1),
			roles: { default_chat: "large" },
		});
		expect(() => loadOperatorModels(PATH, selfhost, reader(f))).toThrow(/sent upstream as org\/large-v2/);
	});

	it("refuses to run on a hosted deployment, whose models are committed config", () => {
		expect(() => loadOperatorModels(PATH, { DEPLOY_ENV: "production", OPENAI_API_KEY: "k" }, reader(file()))).toThrow(
			/read only on a self-hosted Alpha/
		);
	});

	it("names the path when the file is missing or is not JSON", () => {
		const missing = () => {
			throw new Error("ENOENT: no such file or directory");
		};
		expect(() => loadOperatorModels(PATH, selfhost, missing)).toThrow(`${PATH} (ALPHA_MODELS_FILE): cannot be read`);
		expect(() => loadOperatorModels(PATH, selfhost, reader("{ not json"))).toThrow(`${PATH} (ALPHA_MODELS_FILE): is not valid JSON`);
	});

	it("leaves the env untouched when ALPHA_MODELS_FILE is unset", () => {
		const env = { OPENAI_BASE_URL: "http://keep/v1" };
		expect(applyOperatorModels(env, reader(file()))).toBeNull();
		expect(env).toEqual({ OPENAI_BASE_URL: "http://keep/v1" });
	});

	it("loads the committed self-host example as the local profile's one model", () => {
		const loaded = loadOperatorModels(EXAMPLE, selfhost, (p) => readFileSync(p, "utf8"));
		expect(loaded.env.OPENAI_BASE_URL).toBe("http://llama:8080/v1");
		expect(loaded.env.MODEL_ALLOWLIST).toBe("qwen2.5-0.5b-instruct");
	});
});
