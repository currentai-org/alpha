// Sidecar for the updates route's lifetime constants. They live OUTSIDE +server.ts because
// SvelteKit validates route-module exports at build time (only handler names / config / prerender /
// `_`-prefixed are allowed) — and the lifetime invariant spec needs to import these.

// The platform kill this stream's lifetime must stay under. Defined once in the deadline ladder
// ($lib/chat/utils/deadlineLadder) and re-exported here so this route's spec keeps its import; a
// restated copy can drift. Deliberately NOT a per-route `export const config`: a per-route config
// silently splits adapter-vercel's function layout and can drop routes from the catchall manifest
// (see scripts/verify-route-configs.mjs). The platform kills this route at exactly 300s. If the
// project default ever changes, change it in the ladder.
export { PLATFORM_MAX_DURATION_MS } from "$lib/chat/utils/deadlineLadder";

// MUST stay comfortably under PLATFORM_MAX_DURATION_MS: a stream living exactly as
// long as the platform limit (5min == 300s) lets Vercel's kill win the race against the
// graceful close — every invocation is billed the full 5 minutes and logged as a
// runtime timeout ("Task timed out after 300 seconds").
// 4min leaves ~60s of margin, far more than the loop's worst-case overshoot (one poll tick + one
// Mongo query + emits). The invariant is asserted in updates.lifetime.spec.ts.
export const MAX_LIFETIME_MS = 4 * 60_000;
