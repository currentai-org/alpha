import { normalizeFaviconHost } from '$lib/favicon';
import type { RequestHandler } from './$types';

// GET /api/favicon?host=example.com — the site icon for a host, proxied from DuckDuckGo's icon
// service. Proxying keeps the visitor's browser off both the site and the icon service, and the
// upstream is fixed, so the only thing a caller chooses is a validated hostname (see $lib/favicon).
//
// Answers 404 with no body when there is no icon (DuckDuckGo 404s an unknown host), and the client
// draws its own fallback. Both outcomes are cached at the edge: icons rarely change, and a
// sources list asks for the same handful of hosts on every answer.
export const prerender = false;

const UPSTREAM = 'https://icons.duckduckgo.com/ip3/';
const TIMEOUT_MS = 4000;
// The largest icons DuckDuckGo serves are a few tens of kilobytes; anything far past that is not one.
const MAX_BYTES = 256 * 1024;

const HIT_CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';
const MISS_CACHE = 'public, max-age=3600, s-maxage=86400';
// An icon is an image, but an SVG opened directly is a document; this keeps it inert either way.
const SAFETY_HEADERS = {
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
	'x-content-type-options': 'nosniff'
};

const miss = (status: number, cache = MISS_CACHE) =>
	new Response(null, { status, headers: { 'cache-control': cache, ...SAFETY_HEADERS } });

export const GET: RequestHandler = async ({ url, fetch }) => {
	const host = normalizeFaviconHost(url.searchParams.get('host'));
	if (!host) return miss(400, 'no-store');

	let upstream: Response;
	try {
		upstream = await fetch(`${UPSTREAM}${host}.ico`, {
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {
		// Timed out or unreachable: a short-lived miss, so a blip doesn't stick for a day.
		return miss(504, 'public, max-age=300, s-maxage=300');
	}
	const type = upstream.headers.get('content-type') ?? '';
	if (!upstream.ok || !type.startsWith('image/')) return miss(404);

	const body = await upstream.arrayBuffer();
	if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return miss(404);

	return new Response(body, {
		headers: { 'content-type': type, 'cache-control': HIT_CACHE, ...SAFETY_HEADERS }
	});
};
