// Which model fills which role, on which host: one declared shape for the whole inference topology
// (CUR-2277). The shape follows LiteLLM's `model_list` (MIT, github.com/BerriAI/litellm): a provider
// carries its base URL and the NAME of the env var holding its key, never the key itself; a model
// names its provider and the id sent upstream; a role is a named pointer to a model.
//
// Phase 1 builds this from today's env vars at boot (models.ts) and changes nothing that is served.
// What it adds is the check: a role whose model its provider does not list fails loud at boot, where
// today it surfaces as a visitor-facing 400 the first time the role is used. A fallback model id the
// HF router serves under no name would otherwise surface only when failover fires (CUR-2293). Phase 2 moves the values themselves into this file; the
// picker lists below are the first (CUR-3484).

import { z } from "zod";
import { pickerSites, type PickerSite } from "./picker.ts";

/** The two overlays. Every preview deploy shares develop's config; there is never one per branch. */
const environments = ["develop", "production"] as const;
export type InferenceEnvironment = (typeof environments)[number];

const providerSchema = z.object({
	name: z.string().min(1),
	api_base: z.string().url(),
	/** The env var that holds this provider's key. A key value here is a leak, so the shape refuses one. */
	api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "api_key_env names an env var, not a key"),
	/** Whether GET {api_base}/models answers with what this provider serves. */
	lists_models: z.boolean(),
});

const modelSchema = z.object({
	/** The id the app uses for this model, and what roles point at. */
	model_name: z.string().min(1),
	litellm_params: z.object({
		/** The id sent upstream, which can differ from model_name (the backup lane's does). */
		model: z.string().min(1),
		provider: z.string().min(1),
	}),
	model_info: z.object({ supports_function_calling: z.boolean().optional() }).default({}),
});

const rolesSchema = z.object({
	default_chat: z.string().min(1),
	task: z.string().min(1).optional(),
	arithmetic_route: z.string().min(1).optional(),
	compare_panel: z.array(z.string().min(1)).default([]),
	aggregator: z.string().min(1).optional(),
	fallback: z.string().min(1).optional(),
	/** The models a visitor can choose, in picker order. The first is the default chat model. */
	picker: z.array(z.string().min(1)).default([]),
});

const inferenceConfigSchema = z
	.object({
		environment: z.enum(environments),
		providers: z.array(providerSchema).min(1),
		model_list: z.array(modelSchema).min(1),
		roles: rolesSchema,
	})
	.superRefine((cfg, ctx) => {
		const providers = new Set<string>();
		for (const [i, p] of cfg.providers.entries()) {
			if (providers.has(p.name)) {
				ctx.addIssue({ code: "custom", path: ["providers", i, "name"], message: `provider ${p.name} is declared twice` });
			}
			providers.add(p.name);
		}
		const models = new Set<string>();
		for (const [i, m] of cfg.model_list.entries()) {
			if (models.has(m.model_name)) {
				ctx.addIssue({ code: "custom", path: ["model_list", i, "model_name"], message: `model ${m.model_name} is declared twice` });
			}
			models.add(m.model_name);
			if (!providers.has(m.litellm_params.provider)) {
				ctx.addIssue({
					code: "custom",
					path: ["model_list", i, "litellm_params", "provider"],
					message: `model ${m.model_name} names provider ${m.litellm_params.provider}, which is not declared`,
				});
			}
		}
		for (const { role, model } of roleAssignments(cfg.roles)) {
			if (!models.has(model)) {
				ctx.addIssue({ code: "custom", path: ["roles", role], message: `role ${role} names ${model}, which is not in model_list` });
			}
		}
	});

export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;
export type InferenceConfigInput = z.input<typeof inferenceConfigSchema>;
type RoleName = keyof InferenceConfig["roles"];

/** Every (role, model) pair, with the compare panel expanded to one pair per panelist. */
function roleAssignments(roles: z.input<typeof rolesSchema>): { role: RoleName; model: string }[] {
	const out: { role: RoleName; model: string }[] = [];
	for (const [role, value] of Object.entries(roles) as [RoleName, string | string[] | undefined][]) {
		for (const model of Array.isArray(value) ? value : value ? [value] : []) out.push({ role, model });
	}
	return out;
}

/** Parses and cross-checks a config; throws with every problem listed, not only the first. */
export function buildInferenceConfig(input: InferenceConfigInput): InferenceConfig {
	const parsed = inferenceConfigSchema.safeParse(input);
	if (!parsed.success) {
		const lines = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		throw new Error(`[inference] config is invalid:\n  ${lines.join("\n  ")}`);
	}
	return parsed.data;
}

/** develop for every non-production deploy and for local dev. */
export function inferenceEnvironment(vercelEnv: string | undefined): InferenceEnvironment {
	return vercelEnv === "production" ? "production" : "develop";
}

export type UnservedRole = {
	role: RoleName;
	model: string;
	provider: string;
	/** The id that was looked for in the provider's list. */
	upstream: string;
	/** "absent": the list was read and the id is not in it. "unread": the list could not be read. */
	reason: "absent" | "unread";
};

/**
 * Roles whose model its provider does not serve. `served` maps a provider name to the ids its
 * /models listed; a provider that lists models but is missing from the map is reported "unread",
 * because a check that passes when it could not look is the CUR-113 shape. Providers with
 * lists_models false have nothing to check against and are skipped.
 */
export function unservedRoles(cfg: InferenceConfig, served: ReadonlyMap<string, ReadonlySet<string>>): UnservedRole[] {
	const providers = new Map(cfg.providers.map((p) => [p.name, p]));
	const models = new Map(cfg.model_list.map((m) => [m.model_name, m]));
	const out: UnservedRole[] = [];
	for (const { role, model } of roleAssignments(cfg.roles)) {
		const m = models.get(model);
		const provider = m && providers.get(m.litellm_params.provider);
		if (!m || !provider?.lists_models) continue;
		const list = served.get(provider.name);
		const upstream = m.litellm_params.model;
		if (!list) out.push({ role, model, provider: provider.name, upstream, reason: "unread" });
		else if (!list.has(upstream)) out.push({ role, model, provider: provider.name, upstream, reason: "absent" });
	}
	return out;
}

/**
 * One line per role, sorted, for the boot log; the diff of two boots is a diff of these lines. Each
 * line names the provider's host, because a provider name says nothing about which upstream this
 * deployment reaches: the `mistral` lane is the staging router on develop and La Plateforme on www.
 */
export function describeRoles(cfg: InferenceConfig): string[] {
	const models = new Map(cfg.model_list.map((m) => [m.model_name, m]));
	const hosts = new Map(cfg.providers.map((p) => [p.name, new URL(p.api_base).host]));
	return roleAssignments(cfg.roles)
		.map(({ role, model }) => {
			const m = models.get(model)!;
			const provider = m.litellm_params.provider;
			const upstream = m.litellm_params.model === model ? "" : ` (sent as ${m.litellm_params.model})`;
			return `${role}=${model}@${provider}[${hosts.get(provider)}]${upstream}`;
		})
		.sort();
}

export { PICKER, pickerSites, type PickerSite } from "./picker.ts";

/**
 * The site a deployment's picker comes from. `instance` is deploymentInstance()'s answer (`www` when
 * INSTANCE is unset). An instance with no list of its own throws rather than falling back to www's,
 * since a new event instance should get a deliberate list.
 */
/**
 * "production" or "preview" when this process is a deployment (DEPLOY_ENV first, then VERCEL_ENV, the
 * order deployEnv.ts reads them), otherwise null. Committed config decides on a deployment, the env
 * vars off one; primaryModel.ts and config.ts both branch on this.
 */
export function deployedEnv(env: Record<string, string | undefined>): "production" | "preview" | null {
	const raw = (env.DEPLOY_ENV || env.VERCEL_ENV || "").trim();
	return raw === "production" || raw === "preview" ? raw : null;
}

export function pickerSite(vercelEnv: string | undefined, instance: string): PickerSite {
	if (vercelEnv !== "production") return "develop";
	if (instance === "www") return "production";
	if ((pickerSites as readonly string[]).includes(instance)) return instance as PickerSite;
	throw new Error(`[inference] instance "${instance}" has no picker list in config/inference.ts`);
}

/**
 * Which model fills each side-call role, and the backup lane's upstream id. Every deployed site uses
 * the same values (CUR-2277). On a Vercel deployment config.ts serves these and ignores the env var
 * of the same name; off Vercel (local dev, CI, evals) the env var alone decides.
 */
export const ROLE_MODELS = {
	/** Titles, the search classifier, groundcheck and every other side call. */
	TASK_MODEL: "mistral-small-2603",
	/** The math-routing turn planner, and the model that answers the math turns. */
	ARITHMETIC_ROUTE_MODEL: "mistral-medium-2604",
	/** The collective second-opinion panel, in fan-out order. */
	COMPARE_PANEL: [
		"zai-org/GLM-5.2",
		"google/gemma-4-31B-it",
		"speakleash/Bielik-11B-v3.0-Instruct",
		"Qwen/Qwen3.6-35B-A3B",
	],
	/** Writes the second-opinion verdict. */
	AGGREGATOR_MODEL: "zai-org/GLM-5.2",
	/** The sequential panel's first seat, and the RAG entity-scope guard's model. */
	SECOND_OPINION_MODEL: "zai-org/GLM-5.2",
	THIRD_OPINION_MODEL: "utter-project/EuroLLM-22B-Instruct-2512",
	/**
	 * The catalog backup lane's spelling of the primary's id, for a backup host that cases it
	 * differently. Empty: every backup host here spells Apertus, ALIA and Bielik as the primary does.
	 * It never names another model. A person who picks a model gets that model, a retry of it on the
	 * backup host, then an error, and `withOnlyPickedModelLanes` (modelsCatalog.ts) drops any lane
	 * that asks for something else (CUR-3936).
	 */
	FALLBACK_MODEL_ID: "",
} as const satisfies Record<string, string | readonly string[]>;

export type RoleModelKey = keyof typeof ROLE_MODELS;

/** A role as the config string its readers already parse: a list comma-joined, as COMPARE_PANEL was. */
export function roleModelSetting(key: RoleModelKey): string {
	const value: string | readonly string[] = ROLE_MODELS[key];
	return typeof value === "string" ? value : value.join(",");
}

/** Whether `key` names a role whose model this file declares. */
export function isRoleModelKey(key: string): key is RoleModelKey {
	return Object.hasOwn(ROLE_MODELS, key);
}
