// The deployment's identity, read in one place (host-neutral plan, sub-issue 1).
//
// Which environment this is, which commit and branch it was built from, the URL it answers on, the
// project's production URL and the region a function runs in. On Vercel the platform injects each of
// these as a VERCEL_* variable. Every other file in the app reads them through the accessors below, so
// the move to another host is a config change (set DEPLOY_ENV, GIT_REF, GIT_SHA, DEPLOYMENT_URL,
// PRODUCTION_URL, REGION there) rather than an edit at every call site. `eslint.config.js` and
// `eslint.scripts.config.js` fail a VERCEL_* read anywhere else (eslint-rules/no-host-env-read.js).
//
// The host-neutral name wins when it holds a value; Vercel's name is the fallback. `||`, as
// deployEnv.ts has always used for DEPLOY_ENV: a blank value (the manifest scaffold declares every key,
// so an unset one can arrive as "") falls through exactly like an absent one. When the neutral name is
// unset or blank, each accessor returns the Vercel variable's value untouched, undefined and "" alike,
// so a call site that reads `process.env.VERCEL_X` sees the same value. Of the neutral names, only
// DEPLOY_ENV is set on Vercel, to the value VERCEL_ENV carries.
//
// Plain JS with no imports, so sveltekit.config.js, vite.config.ts, config/inference.ts and the .mjs
// scripts can import it as well as server code. It does not validate: `deployEnv()` in
// $lib/chat/server/deployEnv is the checked reading of the environment name, built on deployEnvName().
//
// Every accessor takes the env record to read, defaulting to process.env, and reads it at CALL time:
// the pure helpers that take an env argument (betterAuth.ts, instance.ts, authOrigins.ts) pass theirs
// through, and the specs that stub process.env per test keep working.

/** @typedef {Record<string, string | undefined>} RuntimeEnv */

/**
 * The deployment environment's name, unvalidated: DEPLOY_ENV, else VERCEL_ENV.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function deployEnvName(env = process.env) {
	return env.DEPLOY_ENV || env.VERCEL_ENV;
}

/**
 * Both inputs to deployEnvName(), for a diagnostic that has to say which one was missing.
 * @param {RuntimeEnv} [env]
 * @returns {{ DEPLOY_ENV: string | null; VERCEL_ENV: string | null }}
 */
export function deployEnvSources(env = process.env) {
	return { DEPLOY_ENV: env.DEPLOY_ENV ?? null, VERCEL_ENV: env.VERCEL_ENV ?? null };
}

/**
 * The git branch this deployment was built from: GIT_REF, else VERCEL_GIT_COMMIT_REF.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function gitRef(env = process.env) {
	return env.GIT_REF || env.VERCEL_GIT_COMMIT_REF;
}

/**
 * The commit this deployment was built from: GIT_SHA, else VERCEL_GIT_COMMIT_SHA.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function gitSha(env = process.env) {
	return env.GIT_SHA || env.VERCEL_GIT_COMMIT_SHA;
}

/**
 * This deployment's own hostname, no scheme: DEPLOYMENT_URL, else VERCEL_URL.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function deploymentUrl(env = process.env) {
	return env.DEPLOYMENT_URL || env.VERCEL_URL;
}

/**
 * The project's production hostname, no scheme: PRODUCTION_URL, else VERCEL_PROJECT_PRODUCTION_URL.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function productionUrl(env = process.env) {
	return env.PRODUCTION_URL || env.VERCEL_PROJECT_PRODUCTION_URL;
}

/**
 * The region this function runs in: REGION, else VERCEL_REGION.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function region(env = process.env) {
	return env.REGION || env.VERCEL_REGION;
}

// ── Vercel-only: no neutral name, because the host move replaces the mechanism rather than renaming it.

/**
 * Vercel's Protection Bypass for Automation token, which lets a script or the warm cron past a
 * protected deployment. Ours, though Vercel-named (config/platform-noise.mjs). A host without Vercel's
 * deployment protection has nothing for it to bypass, so it goes with the move instead of moving.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function previewBypassSecret(env = process.env) {
	return env.VERCEL_AUTOMATION_BYPASS_SECRET;
}

/**
 * The commit of this ref's last successful Vercel build, which only Vercel's ignored-build step
 * receives (scripts/vercel-ignore-build.mjs). That step is Vercel's; another host decides whether to
 * build in its own pipeline.
 * @param {RuntimeEnv} [env]
 * @returns {string | undefined}
 */
export function previousBuildSha(env = process.env) {
	return env.VERCEL_GIT_PREVIOUS_SHA;
}
