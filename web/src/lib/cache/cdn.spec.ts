import { describe, expect, it, vi } from 'vitest';

const event = vi.hoisted(() => ({ current: undefined as { locals: App.Locals } | undefined }));
vi.mock('$app/server', () => ({
	getRequestEvent: () => {
		if (!event.current) throw new Error('outside a request');
		return event.current;
	}
}));

import { CDN_PAGE_CACHE_CONTROL, cdnCacheFor, markStandIn } from './cdn';

const page = (cacheControl?: string) =>
	new Response('<html></html>', { headers: cacheControl ? { 'cache-control': cacheControl } : {} });

const standIn = { locals: { servedStandIn: true } as App.Locals };

describe('CDN hold on a stand-in render (CUR-1597)', () => {
	it('shortens a public page to 5s when its render stood in for the CMS', () => {
		const res = cdnCacheFor(page(CDN_PAGE_CACHE_CONTROL), standIn);
		expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=5');
	});

	it('keeps the 60s hold on a render that served real CMS data', () => {
		const res = cdnCacheFor(page(CDN_PAGE_CACHE_CONTROL), { locals: {} as App.Locals });
		expect(res.headers.get('cache-control')).toBe(CDN_PAGE_CACHE_CONTROL);
	});

	it('never makes a private or uncached response public, stand-in or not', () => {
		expect(cdnCacheFor(page('private, no-store'), standIn).headers.get('cache-control')).toBe(
			'private, no-store'
		);
		expect(cdnCacheFor(page(), standIn).headers.get('cache-control')).toBeNull();
	});

	it('marks the current request, and is a no-op with no request to mark', () => {
		const locals = {} as App.Locals;
		event.current = { locals };
		markStandIn();
		expect(locals.servedStandIn).toBe(true);
		event.current = undefined;
		expect(() => markStandIn()).not.toThrow();
	});
});
