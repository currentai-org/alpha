// eslint-disable-next-line no-restricted-imports -- the one place the unguarded json is wrapped
import { json as kitJson } from "@sveltejs/kit";
import type { NoSecretFields } from "./noSecretFields";

/**
 * SvelteKit's `json`, refusing a payload whose type carries a secret-named field (CUR-2643, see
 * noSecretFields.ts). Server code imports this one; lint refuses `json` from `@sveltejs/kit`.
 */
export function json<T>(data: T & NoSecretFields<T>, init?: ResponseInit): Response {
	return kitJson(data, init);
}
