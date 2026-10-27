// The deployment environment, as OUR variable rather than the host's (CUR-208).
//
// Every environment-scoped feature decision in the app reads this: the `env` person-property on
// PostHog flag evaluations (`flags.ts`, `agentMode.ts`) and the env allowlists that decide which
// models a deployment registers at all (`models.ts`). Reading `process.env.VERCEL_ENV` directly
// would tie every one of them to a single host (CUR-46).
//
// The failure that motivates it is silent. Off Vercel, `process.env.VERCEL_ENV` is `undefined`, the
// flag sites fall back to the literal string "development", and any flag scoped
// `env == "production"` or `env == "preview"` matches nothing and evaluates false — for everyone,
// while the deployment boots, serves, and healthchecks green. agentMode.ts records the same
// failure on Vercel when an env condition had no property to match against, and why it is so hard to
// see — "a fail-closed gate returning false looks identical" to the feature simply not being enabled
// for you.
//
// DEPLOY_ENV is read FIRST and VERCEL_ENV is the transitional fallback, so moving to another host is
// a config change rather than a code change. When the fallback is removed, this is the only line
// that has to move.
//
// Read at CALL time, deliberately not frozen at module init. Every spec covering a gated feature
// stubs `process.env` per test (`flags.spec.ts:123`, `agentMode.spec.ts:30`), so a module-level const
// would silently make all of them assert against whatever the environment happened to be when the
// module first loaded.
//
// Returns null rather than defaulting, because the two kinds of caller want opposite things from an
// undeclared environment and neither should inherit the other's choice: the flag sites want a
// harmless placeholder ("development", which matches no prod/preview condition), while a
// registration gated on the environment wants a hard stop — an undeclared env must never register a
// model somewhere nobody intended. A null forces each to say which it is.

import { logger } from "$lib/chat/server/logger";

export type DeployEnv = "production" | "preview" | "development";

const VALID: readonly string[] = ["production", "preview", "development"];

// Warn once per distinct bad value, not once per read: `deployEnv()` sits on the per-request flag
// path, so an unset variable would otherwise emit a line on every turn and bury the thing it warns
// about. Keyed on the value so a genuinely new misconfiguration still gets its own line.
const warned = new Set<string>();

/**
 * The environment this deployment is running as, or `null` when nothing declares one.
 *
 * A null is a MISCONFIGURATION, not a third environment — it means neither `DEPLOY_ENV` nor the
 * host's `VERCEL_ENV` named a recognised value, and every env-scoped feature gate is about to
 * evaluate against nothing. Callers must handle it explicitly.
 */
export function deployEnv(): DeployEnv | null {
	// `||`, not `??`: a blank string (the manifest scaffold declares every key, so an unconfigured
	// DEPLOY_ENV can arrive as "" rather than undefined — CUR-142) must fall through to VERCEL_ENV
	// exactly like an absent one does. Both vars are meant to hold a non-empty environment name, so
	// there is no legitimate falsy value here for `||` to swallow that `??` would have preserved.
	const raw = (process.env.DEPLOY_ENV || process.env.VERCEL_ENV || "").trim();
	if (VALID.includes(raw)) return raw as DeployEnv;

	if (!warned.has(raw)) {
		warned.add(raw);
		logger.warn(
			{
				DEPLOY_ENV: process.env.DEPLOY_ENV ?? null,
				VERCEL_ENV: process.env.VERCEL_ENV ?? null,
				expected: VALID,
			},
			raw === ""
				? "[deploy-env] neither DEPLOY_ENV nor VERCEL_ENV is set — every env-scoped feature flag will evaluate against no environment and fail closed for all users"
				: `[deploy-env] unrecognised deployment environment ${JSON.stringify(raw)} — env-scoped feature flags will fail closed for all users`
		);
	}
	return null;
}

/**
 * Whether a test-only switch may arm here: a declared preview or development deployment, never an
 * undeclared one (CUR-1881). An allow-list, so a deployment that loses its environment label (a move
 * off Vercel, CUR-46) keeps every such switch off, the same choice `carriesFaultInjectToken` and the
 * OTP bypass make.
 */
export function isTestDeployment(): boolean {
	const env = deployEnv();
	return env === "preview" || env === "development";
}

/** Test seam: the warn-once cache is module state and would leak across cases otherwise. */
export function __resetDeployEnvWarnings(): void {
	warned.clear();
}
