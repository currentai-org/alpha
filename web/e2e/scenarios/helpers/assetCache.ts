import type { APIResponse, Route } from '@playwright/test';

export type Cached = { status: number; headers: Record<string, string>; body: Buffer };

/** One test's asset-cache traffic, read by reporters/stepTimings.ts as an annotation. */
export type CacheTally = { hits: number; misses: { path: string; ms: number }[]; retries: number };

/**
 * The fetch errors that mean the connection failed before any answer came back, so a second try can
 * get one, such as a TLS handshake that fails ("Client network socket disconnected before secure TLS
 * connection was established"). An HTTP status is an answer, and a route.fetch that returns one
 * never reaches here.
 */
const TRANSPORT_ERROR =
	/socket disconnected|before secure TLS|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up/i;

function isTransportError(err: unknown): boolean {
	return err instanceof Error && TRANSPORT_ERROR.test(err.message);
}

/** The waits before the second and third tries. */
const RETRY_DELAYS_MS = [250, 1000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
	route: Route,
	path: string,
	tally: CacheTally,
	sleep: (ms: number) => Promise<unknown>
): Promise<APIResponse> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await route.fetch();
		} catch (err) {
			if (!isTransportError(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
			tally.retries += 1;
			console.log(
				`[asset-cache] retry ${attempt + 1} of ${RETRY_DELAYS_MS.length} for ${path}: ${(err as Error).message.split('\n')[0]}`
			);
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
}

export async function serveFromCache(
	route: Route,
	cache: Map<string, Cached>,
	tally: CacheTally,
	sleep: (ms: number) => Promise<unknown> = wait
) {
	const request = route.request();
	if (request.method() !== 'GET') return route.fallback();
	const key = request.url();
	const hit = cache.get(key);
	if (hit) {
		tally.hits += 1;
		return route.fulfill(hit);
	}
	const started = Date.now();
	const path = new URL(key).pathname;
	const response = await fetchWithRetry(route, path, tally, sleep);
	tally.misses.push({ path, ms: Date.now() - started });
	if (response.status() !== 200) return route.fulfill({ response });
	// A cookie set on one test's response must not be replayed into the next test's context.
	const { 'set-cookie': _dropped, ...headers } = response.headers();
	const entry: Cached = { status: 200, headers, body: await response.body() };
	cache.set(key, entry);
	return route.fulfill(entry);
}
