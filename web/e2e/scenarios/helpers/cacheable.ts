// Which requests helpers/test.ts serves from its per-worker cache (CUR-2675). Kept apart from the
// fixture so the rule is unit-testable without Playwright.

const STATIC_FILE = /\.(?:js|mjs|css|woff2?|ttf|png|jpe?g|webp|avif|svg|ico)$/;

// `/rs/*` is the same-origin PostHog proxy. Its `config.js` is live flag config and its event posts
// are what client-exception-capture.spec.ts reads, so neither is cached. The scripts under
// `/rs/static/<version>/` are posthog-js's own files, fixed by the version in the path: about 218k
// preview requests a day (3 scripts x 73k) that no test asserts on.
const POSTHOG_VERSIONED = /^\/rs\/static\/\d+\.\d+\.\d+\/[^/]+\.js$/;

export function isCacheable(url: URL): boolean {
	if (url.pathname.startsWith('/rs/')) return POSTHOG_VERSIONED.test(url.pathname);
	return url.pathname.startsWith('/_app/immutable/') || STATIC_FILE.test(url.pathname);
}
