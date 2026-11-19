// Where this deployment's PostHog lives, read in one place. The browser always talks to the
// same-origin /rs proxy (routes/rs/[...path]); the proxy and the server-side clients (flags, error
// tracking) reach PostHog at POSTHOG_INGEST_HOST. An organisation self-hosting Alpha points that at
// its own PostHog, or at the EU cloud, without touching code. Unset keeps today's US cloud.

const DEFAULT_INGEST = 'https://us.i.posthog.com';

/**
 * The absolute PostHog ingest origin. Only an absolute https origin is honoured; anything else is
 * ignored for the default, so a relative path or a typo can never become an upstream.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function posthogIngestHost(env) {
	const raw = (env.POSTHOG_INGEST_HOST ?? '').trim();
	try {
		const u = new URL(raw);
		if (u.protocol === 'https:' && u.pathname === '/' && !u.search) return u.origin;
	} catch {
		// unset or not a URL
	}
	return DEFAULT_INGEST;
}

/**
 * Where PostHog serves its JS bundle and remote config. PostHog Cloud splits them onto a sibling
 * `<region>-assets` host; a self-hosted PostHog serves both from one origin.
 * @param {string} ingest an origin from posthogIngestHost
 * @returns {string}
 */
export function posthogAssetsHost(ingest) {
	const m = /^https:\/\/([a-z]+)\.i\.posthog\.com$/.exec(ingest);
	return m ? `https://${m[1]}-assets.i.posthog.com` : ingest;
}
