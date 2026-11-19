// Which edition this process is (ALPHA_EDITION, web/config/env-manifest.mjs). Production sets it
// explicitly; a self-host's compose file defaults it to "selfhost". Only the exact value "selfhost"
// (case and surrounding space ignored) counts here: unset, "hosted" or anything else is not a self-host.
// A leaf module, so flags.ts and multimodalMode.ts can both read it without importing each other.
import { config } from "$lib/chat/server/config";

/** True when ALPHA_EDITION is "selfhost". */
export function selfHostEdition(): boolean {
	return String(Reflect.get(config, "ALPHA_EDITION") ?? "").trim().toLowerCase() === "selfhost";
}

/**
 * Does a self-host default stand in for `value`, a setting the operator left unset? True only on a
 * self-host edition with `value` empty, so an operator's explicit "false" is never overridden.
 */
export function selfHostDefaultFor(value: unknown): boolean {
	return String(value ?? "").trim() === "" && selfHostEdition();
}
