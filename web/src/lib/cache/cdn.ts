import { getRequestEvent } from '$app/server';

/**
 * What the CDN may do with a rendered public page (CUR-1597): fresh for 60s, then served stale while
 * one request refreshes it, so a visitor after an idle spell never waits on a cold function.
 */
export const CDN_PAGE_CACHE_CONTROL =
	'public, max-age=0, s-maxage=60, stale-while-revalidate=86400';

/**
 * The tag every CDN-cached CMS page carries in `Vercel-Cache-Tag`, so a publish can delete those
 * entries at once instead of a visitor after a quiet spell getting the pre-edit copy (CUR-1597).
 */
export const CMS_PAGE_CACHE_TAG = 'cms-page';

/**
 * A render that stood in for the CMS (a deadline snapshot, an instance's older value, an empty nav
 * after a failed fetch, the home page's updates count of 0) is still served, but the CDN keeps it
 * for 5s instead of 60s. The refresh after an idle spell lands on a cold instance, the one most
 * likely to stand in, and without this every visitor in the next minute would get that render.
 *
 * No `stale-while-revalidate` (CUR-3700): with one, the CDN serves the expired stand-in as STALE to
 * whoever comes next, however much later, and refreshes behind them, so a tile-less home page would keep
 * reaching visitors for as long as the region stayed quiet. Past 5s the next request renders afresh.
 */
const STAND_IN_CACHE_CONTROL = 'public, max-age=0, s-maxage=5';

/** Record that the current request's render served a stand-in. A no-op outside a request. */
export function markStandIn(): void {
	try {
		getRequestEvent().locals.servedStandIn = true;
	} catch {
		// A background refresh outlives its request; there is no render left to mark.
	}
}

/** Shorten the CDN's hold on a response whose render served a stand-in. `locals` is optional only so a
 *  hand-built test event without it reads as "no stand-in"; SvelteKit always supplies it. */
export function cdnCacheFor(response: Response, event: { locals?: App.Locals }): Response {
	if (!event.locals?.servedStandIn) return response;
	const cacheControl = response.headers.get('cache-control');
	if (!cacheControl?.includes('s-maxage')) return response;
	try {
		response.headers.set('cache-control', STAND_IN_CACHE_CONTROL);
	} catch {
		// Immutable headers come only from a response passed straight through from fetch(), which
		// carries no s-maxage of ours.
	}
	return response;
}
