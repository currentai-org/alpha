// The deployment's identity is read in one module, src/lib/server/runtimeEnv.js, so a host move is a
// config change rather than an edit at every call site (host-neutral plan, sub-issue 1). These
// `no-restricted-syntax` entries fail a read of a Vercel-injected VERCEL_* variable elsewhere in the linted files:
// `process.env.VERCEL_ENV`, `env.VERCEL_URL`, `config.VERCEL_REGION`, `env["VERCEL_GIT_COMMIT_SHA"]`
// and `const { VERCEL_ENV } = process.env` alike, whatever object it is read from.
//
// VERCEL_TOKEN is left out: it is the operator's Vercel API credential, read by the ops scripts that
// drive Vercel itself (verify-prod-build.mjs, resolve-deployment-url.mjs), not something the platform
// tells a deployment about itself. Those scripts go with the platform rather than moving.
//
// Used by eslint.config.js (src/, svelte.config.js, vite.config.ts) and eslint.scripts.config.js
// (scripts/). web/config/ is NOT covered: eslint.config.js ignores config/** globally and no other
// config lints it, so a VERCEL_* read added there passes. None exists today; covering config/ needs an
// ESLint config for it first, which is a separate change. Specs are exempt: they set VERCEL_* to simulate a deployment, which the fallback in
// runtimeEnv.js keeps working.

/** The one file allowed to read a VERCEL_* variable, relative to web/. */
export const RUNTIME_ENV_MODULE = 'src/lib/server/runtimeEnv.js';

const HOST_VAR = '/^VERCEL_(?!TOKEN$)[A-Z0-9_]+$/';

const message =
	'Read the deployment identity through src/lib/server/runtimeEnv.js (deployEnvName, gitRef, gitSha, deploymentUrl, productionUrl, region, previewBypassSecret), never a VERCEL_* variable directly: the host-neutral name wins there and Vercel’s is the fallback, so a host move stays a config change.';

export const noHostEnvRead = [
	{ selector: `MemberExpression[computed=false][property.name=${HOST_VAR}]`, message },
	{ selector: `MemberExpression[computed=true][property.value=${HOST_VAR}]`, message },
	{ selector: `ObjectPattern > Property[key.name=${HOST_VAR}]`, message }
];
