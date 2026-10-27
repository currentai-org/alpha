// CSP violation reports go to PostHog's CSP endpoint (posthog.com/docs/csp-tracking), through the
// same host the client already sends to. Shared by svelte.config.js, which writes the policy's
// report-uri and report-to directives at build time, and hooks.server.ts, which sends the
// Reporting-Endpoints header the report-to directive names. Both read the same env, so the two
// cannot point at different URLs. No key, no endpoint: the directives still apply, silently.

/** The name the policy's report-to directive and the Reporting-Endpoints header share. */
export const CSP_REPORT_GROUP = 'posthog';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function cspReportEndpoint(env) {
	if (!env.PUBLIC_POSTHOG_KEY) return undefined;
	const host = env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
	return `${host}/report/?token=${encodeURIComponent(env.PUBLIC_POSTHOG_KEY)}`;
}
