import { describe, expect, it, vi } from 'vitest';

// Trailing slash is deliberate: PUBLIC_ORIGIN is hand-set per environment, so it may carry one.
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_ORIGIN: 'https://preview.example.com/' }
}));

// `__SITE_ORIGIN__` is '' under test (VERCEL_PROJECT_PRODUCTION_URL is unset), so anything
// absolute here can only have come from PUBLIC_ORIGIN.
const { DEFAULT_OG_IMAGE, resolveCanonicalUrl } = await import('./site');

describe('site origin', () => {
	it('prefers PUBLIC_ORIGIN over the build-baked origin, trailing slash stripped', () => {
		// Exact match, so a surviving trailing slash ('…com//map') fails here too.
		expect(resolveCanonicalUrl('/map')).toBe('https://preview.example.com/map');
	});

	it('uses the same origin for OG images, which scrapers need absolute', () => {
		expect(DEFAULT_OG_IMAGE).toBe('https://preview.example.com/ai-potluck-og-home.jpg');
	});
});
