import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

type Event = Parameters<typeof GET>[0];
const call = (host: string | null, fetch: typeof globalThis.fetch) => {
	const url = new URL('https://www.aipotluck.org/api/favicon');
	if (host !== null) url.searchParams.set('host', host);
	return GET({ url, fetch } as unknown as Event);
};
const icon = (type = 'image/x-icon', status = 200) =>
	vi.fn(
		async () =>
			new Response(new Uint8Array([0, 0, 1, 0]), { status, headers: { 'content-type': type } })
	);

describe('/api/favicon', () => {
	it('asks the fixed icon service for the normalized host and caches the icon', async () => {
		const fetch = icon();
		const res = await call('WWW.Reuters.com', fetch);
		expect(fetch).toHaveBeenCalledWith(
			'https://icons.duckduckgo.com/ip3/reuters.com.ico',
			expect.anything()
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/x-icon');
		expect(res.headers.get('cache-control')).toContain('s-maxage=604800');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
	});

	it('refuses a host that is not a plain public name, without fetching anything', async () => {
		const fetch = icon();
		for (const host of [null, '', '127.0.0.1', 'localhost', 'a.com/../../x', 'evil.com?x=']) {
			expect((await call(host, fetch)).status, String(host)).toBe(400);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it('answers 404 (so the client draws its globe) when upstream has no icon or sends a non-image', async () => {
		expect((await call('nothing-here.example', icon('image/png', 404))).status).toBe(404);
		expect((await call('html.example', icon('text/html'))).status).toBe(404);
	});

	it('answers a short-lived 504 when upstream is unreachable, so a blip is not cached for a day', async () => {
		const res = await call(
			'slow.example',
			vi.fn(async () => Promise.reject(new Error('timeout')))
		);
		expect(res.status).toBe(504);
		expect(res.headers.get('cache-control')).toContain('max-age=300');
	});
});
