// Every environment variable the app reads through `$env/*`. SvelteKit 3 exposes only the variables
// declared here, so this derives them from config/env-manifest.mjs, the single list of keys the code
// reads (scripts/env-audit.mjs fails when code reads a key the manifest lacks).
import { defineEnvVars } from '@sveltejs/kit/env';
import { allKeys, isPublic } from '../config/env-manifest.mjs';

// Set by sveltekit.config.js while the build is configured (VERCEL_GIT_COMMIT_SHA or `git rev-parse
// HEAD`), then inlined at build time. Not manifest keys: nothing deploys them.
const BUILD_TIME = ['PUBLIC_COMMIT_SHA'];

// Optional, as a bag of strings: a missing key reads undefined and the app applies its own fallback.
const optional = (value: string | undefined) => value;

const variables_: Record<string, { public: boolean; static: boolean; schema: typeof optional }> =
	{};
for (const name of allKeys() as string[]) {
	variables_[name] = { public: isPublic(name), static: false, schema: optional };
}
for (const name of BUILD_TIME) {
	variables_[name] = { public: true, static: true, schema: optional };
}

export const variables = defineEnvVars(variables_);
