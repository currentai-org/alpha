// One observable replacement for the silent `read(A) || read(B) || read(C)` credential/config
// fall-through chains scattered across the server. A bare `||` chain hides two failure modes: (1) it falls back to the WRONG key (e.g. embeddings using OPENAI_API_KEY, which can be a
// key for a different host → silent 401), and (2) it resolves to EMPTY (no key at all →
// `Bearer ` → 401 "Invalid username or password") with zero signal. firstKey() does the same lookup but
// LOGS once when it falls past the preferred key or comes up empty, so the failure is visible in the logs
// instead of surfacing as a generic auth error five debugging steps later.

import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";

const read = (key: string): string =>
	((Reflect.get(config, key) as string | undefined) ?? "").trim();
const warned = new Set<string>();

/** Read the first non-empty key from `keys`, in preference order; "" if all empty. Warns ONCE per
 *  `label` on a fall-through-past-the-first-key, and (unless `allowEmpty`) on an all-empty result.
 *  Use `allowEmpty: true` for genuinely-optional config (a bill-to org, an optional model id) where
 *  "" is a valid no-op; leave it off for credentials, where empty means broken. Callers keep their own
 *  fail-open/throw decision (and may append `|| "default"` for non-credential defaults).
 *
 *  `optionalPreferred: true` when keys[0] is an OVERRIDE whose normal state is unset — the fall-through
 *  is then the designed configuration, not a misconfiguration, and it logs at info instead of warn.
 *  Without this, such a chain warns on every cold start describing correct operation, and `warn` is the
 *  level you filter to when something is actually broken. */
export function firstKey(
	keys: string[],
	label: string,
	opts?: { allowEmpty?: boolean; optionalPreferred?: boolean }
): string {
	for (let i = 0; i < keys.length; i++) {
		const v = read(keys[i]);
		if (v) {
			if (i > 0 && !warned.has(label)) {
				warned.add(label);
				const fields = { label, used: keys[i], preferred: keys[0], keyPrefix: v.slice(0, 3) };
				if (opts?.optionalPreferred) {
					logger.info(
						fields,
						`[config] ${label}: optional override '${keys[0]}' unset — using '${keys[i]}' as designed`
					);
				} else {
					logger.warn(
						fields,
						`[config] ${label}: '${keys[0]}' unset — fell back to '${keys[i]}' (verify it's the right kind of key)`
					);
				}
			}
			return v;
		}
	}
	if (!opts?.allowEmpty && !warned.has(label)) {
		warned.add(label);
		logger.warn(
			{ label, keys },
			`[config] ${label}: NONE of ${keys.join(" / ")} is set — resolves EMPTY; any auth/inference using it will fail`
		);
	}
	return "";
}
