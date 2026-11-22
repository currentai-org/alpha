// /rs is the only PostHog proxy, so it alone decides where analytics go. The upstream comes
// from deployment config (POSTHOG_INGEST_HOST), never from the request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { GET, POST } from './+server';

const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

beforeEach(() => {
	for (const k of Object.keys(env)) delete env[k];
	fetchMock.mockClear();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function proxied(
	path: string,
	init?: RequestInit
): Promise<{ url: string; headers: Headers }> {
	const url = new URL(`https://www.example.org${path}`);
	const request = new Request(url, init);
	await (init?.method === 'POST' ? POST : GET)({ url, request } as never);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [target, sent] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	return { url: target, headers: new Headers(sent.headers) };
}

describe('/rs proxy — forwards to the deployment PostHog, whichever host serves the app', () => {
	it('with nothing configured, sends assets to the EU assets host and events to EU ingest', async () => {
		expect((await proxied('/rs/static/array.js')).url).toBe(
			'https://eu-assets.i.posthog.com/static/array.js'
		);
		fetchMock.mockClear();
		expect((await proxied('/rs/array/phc_x/config.js')).url).toBe(
			'https://eu-assets.i.posthog.com/array/phc_x/config.js'
		);
		fetchMock.mockClear();
		expect((await proxied('/rs/e/?ip=1', { method: 'POST', body: '{}' })).url).toBe(
			'https://eu.i.posthog.com/e/?ip=1'
		);
		fetchMock.mockClear();
		expect((await proxied('/rs/flags/?v=2', { method: 'POST', body: '{}' })).url).toBe(
			'https://eu.i.posthog.com/flags/?v=2'
		);
	});

	it('follows POSTHOG_INGEST_HOST to another cloud region and derives its assets host', async () => {
		env.POSTHOG_INGEST_HOST = 'https://ap.i.posthog.com';
		expect((await proxied('/rs/static/array.js')).url).toBe(
			'https://ap-assets.i.posthog.com/static/array.js'
		);
		fetchMock.mockClear();
		expect((await proxied('/rs/flags/?v=2', { method: 'POST', body: '{}' })).url).toBe(
			'https://ap.i.posthog.com/flags/?v=2'
		);
	});

	it("sends both kinds to a self-hosted PostHog's one origin", async () => {
		env.POSTHOG_INGEST_HOST = 'https://posthog.example.net';
		expect((await proxied('/rs/static/array.js')).url).toBe(
			'https://posthog.example.net/static/array.js'
		);
		fetchMock.mockClear();
		expect((await proxied('/rs/e/', { method: 'POST', body: '{}' })).url).toBe(
			'https://posthog.example.net/e/'
		);
	});

	it.each([
		['plain http', 'http://posthog.example.net'],
		['a relative path', '/rs'],
		['an origin with a path', 'https://posthog.example.net/ingest'],
		['not a URL', 'posthog']
	])('ignores %s in POSTHOG_INGEST_HOST and keeps the EU default', async (_label, value) => {
		env.POSTHOG_INGEST_HOST = value;
		expect((await proxied('/rs/e/', { method: 'POST', body: '{}' })).url).toBe(
			'https://eu.i.posthog.com/e/'
		);
	});

	it('cannot be steered to another origin by the request path', async () => {
		const { url } = await proxied('/rs/@evil.example/e/');
		expect(new URL(url).origin).toBe('https://eu.i.posthog.com');
	});

	it("never forwards the site's cookies or credentials", async () => {
		const { headers } = await proxied('/rs/e/', {
			method: 'POST',
			body: '{}',
			headers: {
				cookie: 'session=abc',
				authorization: 'Basic eDp5',
				'content-type': 'application/json'
			}
		});
		expect(headers.get('cookie')).toBeNull();
		expect(headers.get('authorization')).toBeNull();
		expect(headers.get('content-type')).toBe('application/json');
	});
});
