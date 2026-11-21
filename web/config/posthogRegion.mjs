// Which PostHog this deployment and its tooling talk to, read in one place. Every consumer
// (the /rs proxy, the server flag and error clients, the CSP, the flag scripts, the source-map upload,
// the release-note draft) takes its hosts and project from here, so moving region is an env change.
//
//   POSTHOG_INGEST_HOST  where events and flag reads go     unset: https://us.i.posthog.com
//   POSTHOG_APP_HOST     the app and its management API     unset: derived from the ingest host
//   POSTHOG_PROJECT_ID   the project the management API reads   unset: 492965
//
// The assets host (JS bundle, remote config) is derived: PostHog Cloud serves it from a sibling
// `<region>-assets` host, a self-hosted PostHog from its one origin.
//
// Server and Node only. It reads `process.env` when one exists and never a browser variable, so a
// browser bundle that pulled it in would read the defaults rather than throw.

const US_INGEST = "https://us.i.posthog.com";
const US_APP = "https://us.posthog.com";
const US_PROJECT_ID = "492965";

/**
 * An absolute https origin, or undefined. A relative path, a path or query, or a typo is never honoured,
 * so it can never become an upstream.
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
function httpsOrigin(raw) {
	try {
		const u = new URL((raw ?? "").trim());
		if (u.protocol === "https:" && u.pathname === "/" && !u.search) return u.origin;
	} catch {
		// unset or not a URL
	}
	return undefined;
}

/**
 * The absolute PostHog ingest origin.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function posthogIngestHost(env) {
	return httpsOrigin(env.POSTHOG_INGEST_HOST) ?? US_INGEST;
}

/**
 * Where PostHog serves its JS bundle and remote config, for an ingest origin.
 * @param {string} ingest an origin from posthogIngestHost
 * @returns {string}
 */
export function posthogAssetsHost(ingest) {
	const m = /^https:\/\/([a-z]+)\.i\.posthog\.com$/.exec(ingest);
	return m ? `https://${m[1]}-assets.i.posthog.com` : ingest;
}

/**
 * The PostHog app and management API origin. Unset, PostHog Cloud's comes from the ingest region
 * (eu.i -> eu.) and a self-hosted PostHog's is its one origin.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function posthogAppHost(env) {
	const set = httpsOrigin(env.POSTHOG_APP_HOST);
	if (set) return set;
	const ingest = posthogIngestHost(env);
	const m = /^https:\/\/([a-z]+)\.i\.posthog\.com$/.exec(ingest);
	if (m) return `https://${m[1]}.posthog.com`;
	return ingest === US_INGEST ? US_APP : ingest;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function posthogProjectId(env) {
	const id = (env.POSTHOG_PROJECT_ID ?? "").trim();
	return /^\d+$/.test(id) ? id : US_PROJECT_ID;
}

/** Every PostHog Cloud region's ingest and assets hosts, for a CSP that must allow either while a move is under way. */
export const CLOUD_HOSTS = ["us", "eu"].flatMap((r) => [
	`https://${r}.i.posthog.com`,
	`https://${r}-assets.i.posthog.com`,
]);

const processEnv = /** @type {Record<string, string | undefined>} */ (globalThis.process?.env ?? {});

export const ingestHost = posthogIngestHost(processEnv);
export const assetsHost = posthogAssetsHost(ingestHost);
export const appHost = posthogAppHost(processEnv);
export const projectId = posthogProjectId(processEnv);
