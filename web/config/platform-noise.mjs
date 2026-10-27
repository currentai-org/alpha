// @ts-nocheck — plain-JS data module (regex list + trivial helper); imported by both Node scripts and
// the SvelteKit route, so it stays dependency-free JS, same convention as config/env-manifest.mjs.
// config/platform-noise.mjs — the single denylist of env-var names/prefixes that are injected by the
// hosting/DB platform (Vercel, Neon, Node itself) rather than declared by us. Shared by scripts/env-audit.mjs
// (offline completeness gate) and the /chat/admin/env-extract route (full-dump extraction), so both agree on
// what counts as "noise" instead of drifting into two independent lists.
export const PLATFORM_NOISE_PATTERNS = [
	/^POSTGRES_/, // Neon connection-pool bundle Vercel injects alongside DATABASE_URL
	/^VERCEL_/, // Vercel platform metadata (VERCEL_ENV, VERCEL_URL, VERCEL_GIT_*, ...)
	/^VERCEL$/, // Vercel's own "am I running on Vercel" boolean flag
	/^NX_/,
	/^TURBO_/,
	/^NOW_/, // legacy Vercel/Zeit "Now" platform vars, still emitted by some integrations
	// Injected by the Doppler → Vercel sync itself (DOPPLER_PROJECT / DOPPLER_CONFIG /
	// DOPPLER_ENVIRONMENT), not declared by us. Doppler stamps these onto every environment it
	// syncs so a running deployment can report which config it came from. Denylisted rather than
	// declared because they are provenance metadata from the secrets platform, exactly like ^VERCEL_ is
	// from the hosting platform — and because syncing Production would otherwise trip `env-audit --prod` with three undocumented keys (CUR-29).
	/^DOPPLER_/,
	// AWS Lambda execution environment — Vercel runs serverless functions on Lambda, so the AWS
	// runtime injects these into process.env. None are app config. (AWS_REGION, AWS_DEFAULT_REGION,
	// AWS_LAMBDA_*, AWS_EXECUTION_ENV, AWS_ACCESS_KEY_ID, _AWS_XRAY_*, etc.)
	/^AWS_/,
	/^_AWS_/,
	/^_HANDLER$/,
	/^LAMBDA_/,
	// Node / OS runtime + dynamic-linker vars the platform sets (LD_LIBRARY_PATH, LD_PRELOAD,
	// NODE_PATH, NODE_OPTIONS, OPENSSL_CONF, ...). Never app config here.
	/^LD_/,
	/^NODE_/,
	/^OPENSSL_/,
	// Vercel's Axiom integration injects NEXT_PUBLIC_AXIOM_INGEST_ENDPOINT; a Next.js prefix SvelteKit never exposes.
	/^NEXT_PUBLIC_AXIOM_/,
	/^PORT$/, // hosting-injected server bind port, not app config
	/^CI$/,
	/^npm_/,
	/^PATH$/,
	/^HOME$/,
	/^PWD$/,
	/^SHLVL$/,
	/^LANG$/,
	/^LC_/,
	/^TERM$/,
	/^TZ$/,
	/^HOSTNAME$/,
	/^USER$/,
];

// Names that MATCH a pattern above but are genuinely OUR config, not platform-injected. The platform
// owns the `VERCEL_` namespace generally, so the broad prefix is right — but a few keys live inside it
// that WE set and depend on, and filtering those out is worse than letting a stray platform var through
// (the same asymmetry the env-extract route's header describes).
export const PLATFORM_NOISE_EXCEPTIONS = new Set([
	// Protection Bypass for Automation (Project Settings → Deployment Protection). WE set this; the
	// warm cron cannot reach a protected deployment without it — warm.ts's `warmAll` header spells out
	// that platform SSO 401s the cron before the app ever runs, and scripts/warm-cache.mjs reads it
	// directly. Treating it as noise would make it invisible to BOTH consumers: it would never appear
	// in a /chat/admin/env-extract snapshot, and env-audit --prod would never report it as
	// undocumented, so an env reconciliation could drop the one key whose loss silently un-warms the
	// Neon connection (see CUR-47 for what the warm cron sustains).
	"VERCEL_AUTOMATION_BYPASS_SECRET",
]);

export const isPlatformNoise = (key) =>
	!PLATFORM_NOISE_EXCEPTIONS.has(key) && PLATFORM_NOISE_PATTERNS.some((re) => re.test(key));
