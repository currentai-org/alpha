// Builds config/inference.ts's shape from the registry models.ts just published, and checks every
// role against what its provider actually lists (CUR-2277 phase 1). Read-only: nothing here changes
// which model serves a turn. It reads the registry rather than the env vars so that whatever lane
// logic models.ts applies (the backup host, side calls on the Mistral lane) is described as it is.

import {
	buildInferenceConfig,
	describeRoles,
	unservedRoles,
	type InferenceConfig,
	type InferenceEnvironment,
	type UnservedRole,
} from "../../../../config/inference";

/** A lane models.ts knows about. `apiKey` is used to read its /models and never enters the config. */
export type Lane = {
	name: string;
	baseURL: string;
	keyEnv: string;
	listsModels: boolean;
	apiKey?: string;
};

export type RegistryEntry = {
	id: string;
	unlisted?: boolean;
	supportsTools?: boolean;
	endpoints?: { baseURL?: string; modelId?: string }[];
};

export type RoleIds = {
	defaultChat: string;
	task?: string;
	arithmeticRoute?: string;
	comparePanel: string[];
	aggregator?: string;
	/** The ids a visitor can choose; checked like any role, so an unserved picker entry fails at boot. */
	picker?: string[];
};

const norm = (url: string) => url.trim().replace(/\/$/, "");

/**
 * The registry as an inference config. A lane whose base URL another lane already declared is the
 * same provider (prd's backup now calls the gateway itself, CUR-2293), so the first name wins. An
 * endpoint on no declared lane becomes its own provider, named by host, with nothing to check against.
 * A role naming an id the registry does not hold reaches buildInferenceConfig, which throws.
 */
export function topologyFromRegistry(
	registry: readonly RegistryEntry[],
	lanes: readonly Lane[],
	roles: RoleIds,
	environment: InferenceEnvironment
): InferenceConfig {
	const byBase = new Map<string, Lane>();
	for (const lane of lanes) if (lane.baseURL && !byBase.has(norm(lane.baseURL))) byBase.set(norm(lane.baseURL), lane);
	const providerFor = (baseURL: string): string => {
		const known = byBase.get(norm(baseURL));
		if (known) return known.name;
		const host = new URL(baseURL).host;
		byBase.set(norm(baseURL), { name: host, baseURL, keyEnv: "UNDECLARED", listsModels: false });
		return host;
	};

	const model_list: InferenceConfig["model_list"] = [];
	let fallback: string | undefined;
	// The app resolves a model by `.find`, so the first registration of an id is the one served and a
	// later one is dead. A model registered twice (a gateway catalog entry and a branch-scoped
	// registration) would make the boot reject the whole config; the duplicate is skipped
	// here and reported by `shadowedIds` instead.
	const seen = new Set<string>();
	for (const entry of registry) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const [primary, backup] = (entry.endpoints ?? []).filter((e) => e.baseURL);
		if (!primary?.baseURL) continue;
		model_list.push({
			model_name: entry.id,
			litellm_params: { model: primary.modelId ?? entry.id, provider: providerFor(primary.baseURL) },
			model_info: { supports_function_calling: entry.supportsTools ?? false },
		});
		// The backup lane is the default chat model's second endpoint; other models carry the same one.
		if (entry.id === roles.defaultChat && backup?.baseURL) {
			fallback = `backup:${entry.id}`;
			model_list.push({
				model_name: fallback,
				litellm_params: { model: backup.modelId ?? entry.id, provider: providerFor(backup.baseURL) },
				model_info: {},
			});
		}
	}

	return buildInferenceConfig({
		environment,
		providers: [...byBase.values()].map((l) => ({
			name: l.name,
			api_base: norm(l.baseURL),
			api_key_env: l.keyEnv,
			lists_models: l.listsModels,
		})),
		model_list,
		roles: {
			default_chat: roles.defaultChat,
			task: roles.task,
			arithmetic_route: roles.arithmeticRoute,
			compare_panel: roles.comparePanel,
			aggregator: roles.aggregator,
			picker: roles.picker ?? [],
			fallback,
		},
	});
}

export type FetchIds = (baseURL: string, apiKey: string | undefined) => Promise<string[]>;

/** GET {baseURL}/models, ids only. 10 s, one attempt: this is a check, not the catalog load. */
const fetchModelIds: FetchIds = async (baseURL, apiKey) => {
	const res = await fetch(`${norm(baseURL)}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`${res.status} from ${norm(baseURL)}/models`);
	const body = (await res.json()) as { data?: { id?: unknown }[] };
	return (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
};

/**
 * Reads each listing provider's /models, reusing lists already in hand (the primary catalog), and
 * returns the roles that provider does not serve. A list that cannot be read is left out of the map,
 * so its roles come back "unread" rather than passing.
 */
export async function checkRoles(
	cfg: InferenceConfig,
	lanes: readonly Lane[],
	known: ReadonlyMap<string, ReadonlySet<string>>,
	fetchIds: FetchIds = fetchModelIds
): Promise<{ unserved: UnservedRole[]; fetchErrors: Record<string, string> }> {
	const served = new Map(known);
	const fetchErrors: Record<string, string> = {};
	const needed = new Set(
		unservedRoles(cfg, served).filter((r) => r.reason === "unread").map((r) => r.provider)
	);
	await Promise.all(
		cfg.providers
			.filter((p) => needed.has(p.name))
			.map(async (p) => {
				const lane = lanes.find((l) => norm(l.baseURL) === p.api_base);
				try {
					served.set(p.name, new Set(await fetchIds(p.api_base, lane?.apiKey)));
				} catch (e) {
					fetchErrors[p.name] = e instanceof Error ? e.message : String(e);
				}
			})
	);
	return { unserved: unservedRoles(cfg, served), fetchErrors };
}

/** A provider whose /models could not be read at boot, and every role left unchecked because of it. */
export type UncheckedProvider = {
	provider: string;
	host: string;
	error: string;
	/** A fixed token to group on: the 10 s abort, a non-2xx answer, or anything else. */
	reason: "timeout" | "non-ok" | "unreachable";
	/** `role=upstream` for each unchecked role. */
	unchecked: string[];
	/** The log line: which list failed, how, and which roles that leaves unchecked. */
	message: string;
};

/**
 * Groups the "unread" roles by provider, so a cold start that cannot read one list logs one line
 * naming the list, the error and the roles, instead of one bare line per role (CUR-4057).
 */
export function uncheckedProviders(
	cfg: InferenceConfig,
	unserved: readonly UnservedRole[],
	fetchErrors: Readonly<Record<string, string>>
): UncheckedProvider[] {
	const byProvider = new Map<string, string[]>();
	for (const r of unserved) {
		if (r.reason !== "unread") continue;
		byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), `${r.role}=${r.upstream}`]);
	}
	return [...byProvider].map(([provider, unchecked]) => {
		const host = cfg.providers.find((p) => p.name === provider)?.api_base ?? "(unknown host)";
		const error = fetchErrors[provider] ?? "no error recorded";
		const reason = /timeout/i.test(error) ? "timeout" : /^\d{3} from /.test(error) ? "non-ok" : "unreachable";
		const message =
			`[inference] could not read ${provider}'s model list at boot (${host}/models: ${error}), ` +
			`so ${unchecked.length} role${unchecked.length === 1 ? " was" : "s were"} not checked: ${unchecked.join(", ")}`;
		return { provider, host, error, reason, unchecked, message };
	});
}

export { describeRoles };

/** Ids registered more than once. Only the first is ever served, so each later one is dead config. */
export function shadowedIds(registry: readonly RegistryEntry[]): string[] {
	const seen = new Set<string>();
	const dup = new Set<string>();
	for (const e of registry) (seen.has(e.id) ? dup : seen).add(e.id);
	return [...dup];
}
