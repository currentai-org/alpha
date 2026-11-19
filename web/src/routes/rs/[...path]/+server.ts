import { env } from '$env/dynamic/private';
import { posthogAssetsHost, posthogIngestHost } from '$lib/posthogUpstream';
import type { RequestHandler } from './$types';

// First-party PostHog proxy (ad-blocker evasion; path `/rs` — see web/docs/posthog-reverse-proxy.md).
//
// The ONLY PostHog proxy: it works the same in local dev, on Vercel and on any host that
// runs the container. vercel.json's three edge rewrites that used to sit in front of it are gone, so a
// host that never reads vercel.json loses nothing.
//
// SECURITY: the upstreams come from deployment config (POSTHOG_INGEST_HOST, absolute https only, see
// posthogUpstream.js) and are never derived from the request, so this can only forward to the
// deployment's own PostHog — it is not an open proxy / SSRF surface. `/static/*` (JS bundle, recorder,
// surveys) and `/array/*` (remote config `config.js`) go to the assets host; everything else
// (`/e`, `/i/v0/e`, `/flags`, `/decide`, `/report`) to ingestion.

// Always dynamic; never prerender this route. And don't 308-redirect posthog's `/rs/e/`
// (trailing slash) — proxy it exactly as sent.
export const prerender = false;
export const trailingSlash = 'ignore';

// Hop-by-hop / identity headers that must not be forwarded verbatim. `cookie` + `authorization` are
// dropped so we don't leak the site's cookies or its credentials to PostHog — and the preview
// deployment's basic-auth sends `Authorization: Basic …`, which PostHog's S3-backed assets host
// (`/static/*`) answers with a 400 (`Unsupported Authorization Type`). `host` is dropped so
// fetch sets the upstream's own.
const STRIP_REQ = new Set([
	'host',
	'connection',
	'content-length',
	'cookie',
	'authorization',
	'x-forwarded-host'
]);
// Stale after undici auto-decodes the gzip response body — leaving them makes the browser try to
// gunzip an already-plain body and error.
const STRIP_RES = new Set([
	'content-encoding',
	'content-length',
	'transfer-encoding',
	'connection'
]);

const handler: RequestHandler = async ({ url, request }) => {
	// Exact path after `/rs/`, trailing slash preserved. String-concat onto a fixed host literal so
	// the path can never redirect the request to another origin.
	const rest = url.pathname.replace(/^\/rs\/?/, '');
	const ingest = posthogIngestHost(env);
	const host =
		rest.startsWith('static/') || rest.startsWith('array/') ? posthogAssetsHost(ingest) : ingest;
	const target = `${host}/${rest}${url.search}`;

	const headers = new Headers();
	for (const [k, v] of request.headers) if (!STRIP_REQ.has(k.toLowerCase())) headers.set(k, v);

	// `follow` (not `manual`): resolve any upstream redirect server-side so a posthog `Location`
	// never leaks to the browser, which would bypass the proxy (and the ad-blocker evasion). The
	// happy paths don't redirect; this is just belt-and-suspenders.
	const init: RequestInit = { method: request.method, headers, redirect: 'follow' };
	if (request.method !== 'GET' && request.method !== 'HEAD')
		init.body = await request.arrayBuffer();

	const res = await fetch(target, init);

	const outHeaders = new Headers(res.headers);
	for (const h of STRIP_RES) outHeaders.delete(h);
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: outHeaders
	});
};

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
export const HEAD = handler;
