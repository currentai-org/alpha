import { describe, expect, it, vi } from 'vitest';
import type { APIResponse, Route } from '@playwright/test';
import { serveFromCache, type Cached, type CacheTally } from '../scenarios/helpers/assetCache';

const DROPPED =
	'route.fetch: Client network socket disconnected before secure TLS connection was established';
const URL_ = 'https://preview.example.org/_app/immutable/chunks/app.js';

function response(status: number): APIResponse {
	return {
		status: () => status,
		headers: () => ({ 'content-type': 'text/javascript', 'set-cookie': 'x=1' }),
		body: async () => Buffer.from('js')
	} as unknown as APIResponse;
}

/** A route whose fetch runs the given outcomes in order: an Error is thrown, a number is a status. */
function fakeRoute(outcomes: (Error | number)[]) {
	const fetch = vi.fn(async () => {
		const next = outcomes.shift();
		if (next instanceof Error) throw next;
		return response(next ?? 200);
	});
	const fulfill = vi.fn(async () => {});
	const route = {
		request: () => ({ method: () => 'GET', url: () => URL_ }),
		fetch,
		fulfill,
		fallback: vi.fn(async () => {})
	} as unknown as Route;
	return { route, fetch, fulfill };
}

const tally = (): CacheTally => ({ hits: 0, misses: [], retries: 0 });
const noWait = async () => {};

describe('the scenario asset cache', () => {
	it('fetches again when the TLS connection drops, then serves and caches the answer', async () => {
		const { route, fetch, fulfill } = fakeRoute([new Error(DROPPED), 200]);
		const cache = new Map<string, Cached>();
		const t = tally();
		await serveFromCache(route, cache, t, noWait);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(t.retries).toBe(1);
		expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
		expect(cache.get(URL_)?.headers).not.toHaveProperty('set-cookie');
	});

	it('never fetches again on an HTTP error status: a 500 is passed through as it came', async () => {
		const { route, fetch, fulfill } = fakeRoute([500, 200]);
		const cache = new Map<string, Cached>();
		const t = tally();
		await serveFromCache(route, cache, t, noWait);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(t.retries).toBe(0);
		expect(cache.size).toBe(0);
		expect(fulfill).toHaveBeenCalledWith({ response: expect.anything() });
	});

	it('gives up after two retries, and does not retry an error that is not a dropped connection', async () => {
		const dropped = fakeRoute([new Error(DROPPED), new Error(DROPPED), new Error(DROPPED), 200]);
		const t = tally();
		await expect(serveFromCache(dropped.route, new Map(), t, noWait)).rejects.toThrow(/secure TLS/);
		expect(dropped.fetch).toHaveBeenCalledTimes(3);
		expect(t.retries).toBe(2);

		const other = fakeRoute([
			new Error('route.fetch: Target page, context or browser has been closed'),
			200
		]);
		await expect(serveFromCache(other.route, new Map(), tally(), noWait)).rejects.toThrow(/closed/);
		expect(other.fetch).toHaveBeenCalledTimes(1);
	});
});
