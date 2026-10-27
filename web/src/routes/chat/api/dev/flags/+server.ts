import { dev } from "$app/environment";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { FLAG_KEYS } from "$lib/chat/server/flagKeys";
import { ensureFlagsPolled, flagEnabledOr, fuzzOverrideEnabled } from "$lib/chat/server/flags";
import type { RequestHandler } from "./$types";

/**
 * Dev servers only: every registered flag and what this request resolves it to, for the account
 * menu's Feature flags (Dev) dialog. Local overrides ride the `fuzz_override` cookie (CUR-1044), which
 * the server honours only with FUZZ_OVERRIDE_ENABLED set; `overridesActive` says whether it is.
 */
export const GET: RequestHandler = async () => {
	if (!dev) error(404, "Not found");
	await ensureFlagsPolled();
	return json({
		overridesActive: fuzzOverrideEnabled(),
		flags: FLAG_KEYS.map((f) => ({
			key: f.key,
			class: f.class,
			gates: f.gates,
			ticket: f.ticket,
			on: flagEnabledOr(f.key, () => f.codeDefault === "on"),
		})),
	});
};
