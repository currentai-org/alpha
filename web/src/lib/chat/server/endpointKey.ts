// Provider keys on the model registry (CUR-2640).
//
// A registry endpoint names the env var its key lives in (`apiKeyEnv: "HF_TOKEN"`) and never holds the
// value. The registry is long-lived and gets serialized (routes, logs, the inference-topology report),
// so a value there leaks wherever the object goes; a name does not. Readers resolve the value at call
// time with `endpointApiKey`.
import { config } from "$lib/chat/server/config";

/** The value of env var `name` from the app config, trimmed; undefined when unset or blank. */
export function configKey(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return ((Reflect.get(config, name) as string | undefined) ?? "").trim() || undefined;
}

/**
 * The first of `names` that holds a non-blank value, in preference order, or undefined when none
 * does. The name-returning twin of `firstKey`, for a lane that records where its key comes from.
 */
export function firstSetKeyEnv(names: readonly string[]): string | undefined {
	return names.find((name) => configKey(name) !== undefined);
}

/**
 * The key a registry endpoint sends, read from config at call time. undefined when the endpoint names
 * no env var (the caller's own default applies, e.g. endpointOai's OPENAI_API_KEY/HF_TOKEN) or the
 * named var is blank.
 */
export function endpointApiKey(endpoint: { apiKeyEnv?: string } | undefined): string | undefined {
	return configKey(endpoint?.apiKeyEnv);
}

/**
 * The fixed key a per-user local endpoint sends (localModels.ts). Not a secret: it exists so
 * endpointOai's default, our gateway key, never goes to a user's URL (CUR-3177). The only `apiKey`
 * a registry endpoint may carry.
 */
export const LOCAL_ENDPOINT_API_KEY = "sk-local" as const;
