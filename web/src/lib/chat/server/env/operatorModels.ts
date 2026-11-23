// A self-hosted Alpha's own model list. ALPHA_MODELS_FILE names a JSON file outside web/config/
// holding providers, models and roles in config/inference.ts's schema. The file replaces the env vars the
// model layer reads (OPENAI_BASE_URL, OPENAI_API_KEY, MODEL_ALLOWLIST and the role models), so a self-host
// changes which models it offers by editing its own file, never the repo.
//
// It is validated where the env is read, at boot: a role naming a model the file does not list, or any
// other schema problem, throws with the file's path in the message, and the server does not start.
//
// The model layer serves ONE OpenAI-compatible endpoint, so every model the picker or a role uses must sit
// on one provider. Routing across several is separate work.

import { readFileSync } from "node:fs";
import {
	buildInferenceConfig,
	committedConfigEnv,
	inferenceEnvironment,
	type InferenceConfig,
} from "../../../../../config/inference";
import { deployEnvName } from "../../../server/runtimeEnv.js";

const MODELS_FILE_ENV = "ALPHA_MODELS_FILE";

/** The env vars an operator file decides. Set from the file, or cleared when the file leaves a role out. */
const ROLE_ENV = {
	task: "TASK_MODEL",
	arithmetic_route: "ARITHMETIC_ROUTE_MODEL",
	compare_panel: "COMPARE_PANEL",
	aggregator: "AGGREGATOR_MODEL",
} as const;

/** Model settings the file replaces, so a stale value in .env cannot quietly win over it. */
const REPLACED_ENV = [
	"OPENAI_BASE_URL",
	"OPENAI_API_KEY",
	"OPENAI_API_BASE_URLS",
	"OPENAI_API_KEYS",
	"MODEL_ALLOWLIST",
	"SECOND_OPINION_MODEL",
	"THIRD_OPINION_MODEL",
	...Object.values(ROLE_ENV),
] as const;

export type OperatorModels = {
	path: string;
	config: InferenceConfig;
	/** The env values the file sets. An empty string clears a setting. */
	env: Record<string, string>;
	/** Env vars that held a value before the file replaced them, names only. */
	replaced: string[];
};

const fail = (path: string, problem: string): never => {
	throw new Error(`[models file] ${path} (${MODELS_FILE_ENV}): ${problem}`);
};

/**
 * Read, validate and translate the operator file `path` into the env the model layer reads. Pure apart
 * from the read, which `read` replaces in specs. Throws with `path` in the message on any problem.
 */
function loadOperatorModels(
	path: string,
	env: Record<string, string | undefined>,
	read: (p: string) => string = (p) => readFileSync(p, "utf8")
): OperatorModels {
	if (committedConfigEnv(env)) {
		fail(
			path,
			"the file is read only on a self-hosted Alpha. Set ALPHA_EDITION=selfhost, or unset ALPHA_MODELS_FILE on a hosted deployment, whose models come from config/inference.ts."
		);
	}
	let raw: string;
	try {
		raw = read(path);
	} catch (e) {
		return fail(path, `cannot be read: ${e instanceof Error ? e.message : String(e)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return fail(path, `is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(path, "must hold one JSON object with providers, model_list and roles");
	}

	let config: InferenceConfig;
	try {
		config = buildInferenceConfig({
			environment: inferenceEnvironment(deployEnvName(env)),
			...(parsed as Record<string, unknown>),
		} as Parameters<typeof buildInferenceConfig>[0]);
	} catch (e) {
		return fail(path, e instanceof Error ? e.message : String(e));
	}

	const models = new Map(config.model_list.map((m) => [m.model_name, m]));
	for (const m of config.model_list) {
		if (m.litellm_params.model !== m.model_name) {
			fail(
				path,
				`model ${m.model_name} is sent upstream as ${m.litellm_params.model}. Alpha lists a model by the id its server reports, so set model_name to ${m.litellm_params.model}.`
			);
		}
	}

	const { roles } = config;
	const picker = roles.picker.length
		? roles.picker
		: [roles.default_chat, ...config.model_list.map((m) => m.model_name).filter((id) => id !== roles.default_chat)];
	if (picker[0] !== roles.default_chat) {
		fail(path, `roles.default_chat is ${roles.default_chat}, but the first picker entry is ${picker[0]}. The first picker entry is the default chat model, so make them the same.`);
	}

	const provider = models.get(roles.default_chat)!.litellm_params.provider;
	const used = new Set([
		...picker,
		...[roles.task, roles.arithmetic_route, roles.aggregator, ...roles.compare_panel].filter((id): id is string => !!id),
	]);
	for (const id of used) {
		const p = models.get(id)!.litellm_params.provider;
		if (p !== provider) {
			fail(path, `model ${id} is on provider ${p}, but the default chat model is on ${provider}. Alpha serves one endpoint, so every model it offers or gives a role must be on one provider.`);
		}
	}

	const prov = config.providers.find((p) => p.name === provider)!;
	const key = (env[prov.api_key_env] ?? "").trim();
	if (!key) {
		fail(path, `provider ${provider} reads its key from ${prov.api_key_env}, which is not set. For a server that takes no key, set it to any value, such as none.`);
	}

	const out: Record<string, string> = {
		OPENAI_BASE_URL: prov.api_base.replace(/\/$/, ""),
		OPENAI_API_KEY: key,
		OPENAI_API_BASE_URLS: "",
		OPENAI_API_KEYS: "",
		MODEL_ALLOWLIST: picker.join(","),
		SECOND_OPINION_MODEL: "",
		THIRD_OPINION_MODEL: "",
		[ROLE_ENV.task]: roles.task ?? "",
		[ROLE_ENV.arithmetic_route]: roles.arithmetic_route ?? "",
		[ROLE_ENV.compare_panel]: roles.compare_panel.join(","),
		[ROLE_ENV.aggregator]: roles.aggregator ?? "",
	};
	const replaced = REPLACED_ENV.filter((k) => (env[k] ?? "").trim() && env[k] !== out[k]);
	return { path, config, env: out, replaced };
}

/**
 * When ALPHA_MODELS_FILE is set, load it and write its values into `env` (mutated in place). Returns the
 * load, or null when the variable is unset. Throws on any problem with the file.
 */
export function applyOperatorModels(
	env: Record<string, string | undefined>,
	read?: (p: string) => string
): OperatorModels | null {
	const path = (env[MODELS_FILE_ENV] ?? "").trim();
	if (!path) return null;
	const loaded = loadOperatorModels(path, env, read);
	Object.assign(env, loaded.env);
	return loaded;
}
