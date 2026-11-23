import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The catalog proxy fronts whatever gateway the deployment names. It has no default host: a fork
// that turns the adapter on without FOLKWAYS_CATALOG_BASE_URL must be told what is missing, not
// sent to someone else's gateway.

const mockEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => mockEnv);
vi.mock('./flag', () => ({ adapterGate: async () => null }));

import { proxyUpstreamGet } from './upstreamGet';

const request = () =>
	new Request('http://adapter/v1/models', { headers: { authorization: 'Bearer sk-host' } });

describe('folkways catalog proxy', () => {
	const fetchSpy = vi.fn();

	beforeEach(() => {
		mockEnv.env = {};
		fetchSpy.mockReset().mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
	});
	afterEach(() => vi.unstubAllGlobals());

	it('with no catalog base URL configured, answers 503 naming the variable and calls no host', async () => {
		const res = await proxyUpstreamGet(request(), '/models');

		expect(res.status).toBe(503);
		expect((await res.json()).error.message).toContain('FOLKWAYS_CATALOG_BASE_URL');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('proxies to the configured catalog base URL, trailing slash trimmed', async () => {
		mockEnv.env.FOLKWAYS_CATALOG_BASE_URL = 'https://gateway.example.test/v1/';

		const res = await proxyUpstreamGet(request(), '/models');

		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://gateway.example.test/v1/models',
			expect.anything()
		);
	});
});
