// Where this deployment's PostHog lives. The browser always talks to the same-origin /rs
// proxy (routes/rs/[...path]); the proxy and the server-side clients (flags, error tracking) reach
// PostHog at POSTHOG_INGEST_HOST. An organisation self-hosting Alpha points that at its own PostHog, or
// at the EU cloud, without touching code. Unset keeps today's US cloud.
//
// The logic lives in config/posthogRegion.mjs, the one place every PostHog consumer reads its region
// from; this module keeps the names the app already imports.

export { posthogAssetsHost, posthogIngestHost } from '../../config/posthogRegion.mjs';
