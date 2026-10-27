import { LOOK_PARAM, parseLook } from '$lib/alpha-landing/looks/looks';
import type { PageLoad } from './$types';

// A composed layout using the Alpha product-page global in Payload.
//
// Prerender stays off. The root layout loads the live menu on each request, and
// an unlinked prerenderable route fails the crawl check in svelte.config.js.
export const prerender = false;

export const load: PageLoad = ({ url, data }) => ({
	...data,
	look: parseLook(url.searchParams.get(LOOK_PARAM))
});
