// Reuses the exact mechanism web/scripts/fuzz/agent-loop.mjs already established — the
// `fuzz_override` cookie (flags.ts's fuzzOverrideValue, hooks/handle.ts's parse) — rather than
// inventing a second one. Requires FUZZ_OVERRIDE_ENABLED=true in the target deployment's
// config; hard-gated off in production regardless (flags.ts, in code).
import type { BrowserContext } from '@playwright/test';
import { FLAG_KEY_NAMES, type FlagKey } from '../../../src/lib/chat/server/flagKeys';

/**
 * Throws on a key flagKeys.ts does not declare. The server ignores an override for a key it never
 * reads, so a retired or misspelled key would leave the spec running on a setup that does nothing
 * (CUR-4588). The `FlagKey` type says the same thing at compile time; this covers a key that
 * reaches here through a `Record<string, boolean>` the type cannot see into.
 */
export function assertKnownFlagKeys(flags: Partial<Record<FlagKey, boolean>>): void {
	const known = new Set<string>(FLAG_KEY_NAMES);
	const unknown = Object.keys(flags).filter((k) => !known.has(k));
	if (unknown.length) {
		throw new Error(
			`setFlagOverrides: ${unknown.join(', ')} is not in src/lib/chat/server/flagKeys.ts, so forcing it does nothing. Remove it if the flag was retired, or fix the spelling.`
		);
	}
}

export async function setFlagOverrides(
	context: BrowserContext,
	baseURL: string,
	flags: Partial<Record<FlagKey, boolean>>
): Promise<void> {
	assertKnownFlagKeys(flags);
	const value = Object.entries(flags)
		.map(([k, v]) => `${k}:${v}`)
		.join(',');
	const domain = new URL(baseURL).hostname;
	await context.addCookies([
		{ name: 'fuzz_override', value, domain, path: '/' },
		...fuzzOverrideKeyCookie(domain)
	]);
}

/**
 * A hosted preview honours `fuzz_override` only alongside `fuzz_override_key` (CUR-3516, flags.ts's
 * fuzzOverrideAuthorized). Without the token a spec would run against the unforced flag and pass or
 * fail for the wrong reason, so a hosted target with no token throws here instead.
 */
function fuzzOverrideKeyCookie(domain: string) {
	const token = process.env.E2E_OTP_BYPASS_TOKEN;
	if (token) return [{ name: 'fuzz_override_key', value: token, domain, path: '/' }];
	if (domain === 'localhost' || domain === '127.0.0.1') return [];
	throw new Error(
		`setFlagOverrides: ${domain} honours fuzz_override only with fuzz_override_key, and E2E_OTP_BYPASS_TOKEN is unset`
	);
}
