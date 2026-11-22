// A site-only build (www once chat lives on alpha) serves the site and none of chat. Every
// chat address answers 308 to the chat host, whatever the method or the Accept header, and chat's
// request chain never loads. The names state the contract: a test that only checked "redirects pages"
// would stay green while www kept answering chat's API, which is the hole a cold walk found.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleRequest = vi.fn(async () => new Response('chat answered', { status: 200 }));
const handleServerError = vi.fn(async () => ({ message: 'chat handled' }));
const handleFetchRequest = vi.fn(async () => new Response('chat fetch'));
const preconnectDb = vi.fn();
const validateEnv = vi.fn();
const initServer = vi.fn(async () => {});

vi.mock('$app/environment', () => ({ building: false, dev: false }));
vi.mock('$lib/surface', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/surface')>()),
	APP_SURFACE: 'site-only'
}));
vi.mock('$lib/chat/server/db/client', () => ({ preconnectDb }));
vi.mock('$lib/chat/server/hooks/handle', () => ({ handleRequest }));
vi.mock('$lib/chat/server/hooks/error', () => ({ handleServerError }));
vi.mock('$lib/chat/server/hooks/fetch', () => ({ handleFetchRequest }));
vi.mock('$lib/chat/server/hooks/init', () => ({ initServer }));
vi.mock('$lib/chat/server/env/validate', () => ({ validateEnv }));
// The handoff seals with GUEST_HANDOFF_SECRET; config snapshots env at import, so set it here.
vi.mock('$lib/chat/server/config', async (importOriginal) => {
	const real = (await importOriginal<typeof import('$lib/chat/server/config')>()).config;
	const config = new Proxy(real, {
		get(target, key) {
			if (key === 'GUEST_HANDOFF_SECRET') return 'site-only-handoff-secret';
			if (key === 'BETTER_AUTH_SECRET') return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { config };
});
vi.mock('$lib/chat/server/errorTracking', () => ({ captureServerException: vi.fn() }));
vi.mock('$lib/website.server', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/website.server')>()),
	startCms: vi.fn(async () => {}),
	cmsRedirect: vi.fn(async () => null)
}));

const PAGE_LOAD = {
	'sec-fetch-mode': 'navigate',
	'sec-fetch-dest': 'document',
	accept: 'text/html'
};
const JSON_FETCH = { accept: 'application/json' };

async function answer(
	href: string,
	init: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}
) {
	const { handleApplication } = await import('./hooks.server');
	const url = new URL(href);
	const method = init.method ?? 'GET';
	const request = new Request(url, {
		method,
		headers: init.headers ?? {},
		body: method === 'GET' || method === 'HEAD' ? undefined : '{}'
	});
	const jar = init.cookies ?? {};
	const resolve = vi.fn(async () => new Response('site page', { status: 200 }));
	const response = (await handleApplication({
		event: {
			url,
			request,
			route: { id: null },
			locals: {},
			cookies: {
				get: (name: string) => jar[name],
				getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
				delete: vi.fn(),
				set: vi.fn()
			}
		},
		resolve
	} as never)) as Response;
	return { response, resolve };
}

// The site-only redirect is the site's own code, reached through the website.server seam. The public
// Alpha tree ships this spec beside hooks.server.ts but leaves out the whole site directory, so there it
// has nothing to test. Only that whole-directory absence skips: with the site present and siteOnly.ts
// renamed or moved, the guard below fails instead of letting the suite skip green.
const SITE_FILES = Object.keys(import.meta.glob('/src/lib/website/**'));
const SITE_CODE = SITE_FILES.length > 0;
if (SITE_CODE && !SITE_FILES.includes('/src/lib/website/siteOnly.ts')) {
	throw new Error(
		'web/src/lib/website/siteOnly.ts is missing while the site is present: update this spec and the website.server seam to its new path'
	);
}

beforeEach(() => {
	vi.stubEnv('DEPLOY_ENV', 'production');
	handleRequest.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!SITE_CODE)('site-only: chat addresses on www move to alpha', () => {
	it('answers 308 to alpha for a JSON GET of /chat/api/models, keeping its /chat/api path', async () => {
		const { response } = await answer('https://www.example.test/chat/api/models', {
			headers: JSON_FETCH
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://alpha.example.test/chat/api/models');
	});

	it('answers 308 to alpha /settings for a page load of /chat/settings', async () => {
		const { response } = await answer('https://www.example.test/chat/settings', {
			headers: PAGE_LOAD
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://alpha.example.test/settings');
	});

	it('answers 308 for a POST too, which keeps its method and body across the move', async () => {
		const { response } = await answer('https://www.example.test/chat/conversation', {
			method: 'POST',
			headers: JSON_FETCH
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://alpha.example.test/conversation');
	});

	it('answers 308 for the healthcheck, sign-in and .well-known paths a monitor or an OAuth server calls', async () => {
		for (const path of [
			'/chat/healthcheck',
			'/chat/api/auth/get-session',
			'/chat/.well-known/oauth-cimd'
		]) {
			const { response } = await answer(`https://www.example.test${path}`, {
				headers: JSON_FETCH
			});
			expect(response.status, path).toBe(308);
			expect(response.headers.get('location'), path).toBe(`https://alpha.example.test${path}`);
		}
	});

	it("moves chat's root paths: the folkways adapter as itself, the retired /alpha/chat to alpha's home", async () => {
		const adapter = await answer(
			'https://www.example.test/folkways-adapter/mistral/v1/chat/completions',
			{ method: 'POST', headers: JSON_FETCH }
		);
		expect(adapter.response.headers.get('location')).toBe(
			'https://alpha.example.test/folkways-adapter/mistral/v1/chat/completions'
		);
		const alias = await answer('https://www.example.test/alpha/chat?x=1', { headers: PAGE_LOAD });
		expect(alias.response.headers.get('location')).toBe('https://alpha.example.test/?x=1');
	});

	it('never stores the answer in a cache, since a guest cookie can turn it into the handoff page', async () => {
		const { response } = await answer('https://www.example.test/chat/api/models');
		expect(response.headers.get('cache-control')).toContain('no-store');
	});

	it('sends a non-production site-only build to alpha-develop, never to production alpha', async () => {
		vi.stubEnv('DEPLOY_ENV', 'preview');
		const { response } = await answer('https://develop.example.test/chat/settings', {
			headers: PAGE_LOAD
		});
		expect(response.headers.get('location')).toBe('https://alpha-develop.example.test/settings');
	});

	it("never runs chat's request chain for any chat address", async () => {
		await answer('https://www.example.test/chat', { headers: PAGE_LOAD });
		await answer('https://www.example.test/chat/api/models', { headers: JSON_FETCH });
		expect(handleRequest).not.toHaveBeenCalled();
	});
});

describe.skipIf(!SITE_CODE)("site-only: the scheduled jobs run on alpha's project alone", () => {
	it('answers 404, not a 308, for every cron path vercel.json registers, so www runs none of them', async () => {
		const { default: vercelConfig } = await import('../vercel.json');
		const paths = vercelConfig.crons.map((cron) => cron.path);
		expect(paths).toEqual(expect.arrayContaining(['/chat/api/probes', '/chat/api/cleanup']));
		for (const path of paths) {
			const { response, resolve } = await answer(`https://www.example.test${path}`, {
				headers: { 'user-agent': 'vercel-cron/1.0', authorization: 'Bearer cron' }
			});
			expect(response.status, path).toBe(404);
			expect(response.headers.get('location'), path).toBeNull();
			expect(resolve, path).not.toHaveBeenCalled();
		}
		expect(handleRequest).not.toHaveBeenCalled();
	});
});

describe.skipIf(!SITE_CODE)('site-only: the site itself', () => {
	it('serves / and /map through the site, not a redirect', async () => {
		for (const path of ['/', '/map', '/about']) {
			const { response, resolve } = await answer(`https://www.example.test${path}`, {
				headers: PAGE_LOAD
			});
			expect(response.status, path).toBe(200);
			expect(resolve, path).toHaveBeenCalled();
		}
	});

	it('keeps the CMS webhook and the PostHog proxy on www, since the site uses both', async () => {
		for (const path of ['/api/cms/invalidate', '/rs/decide']) {
			const { response } = await answer(`https://www.example.test${path}`, {
				method: 'POST',
				headers: JSON_FETCH
			});
			expect(response.status, path).toBe(200);
		}
	});
});

describe.skipIf(!SITE_CODE)('site-only: a guest still carries their session to alpha', () => {
	it('answers a page load from a guest with the handoff page instead of a bare 308', async () => {
		const { response } = await answer('https://www.example.test/chat/settings', {
			headers: PAGE_LOAD,
			cookies: { 'hf-chat': '0b9f4d52-6a8e-4f1c-9a43-2f6d8c1e7a10' }
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('action="https://alpha.example.test/chat/guest-handoff"');
		expect(html).toContain('name="next" value="/settings"');
	});

	it('gives an API call from a guest the plain 308, never the handoff page', async () => {
		const { response } = await answer('https://www.example.test/chat/api/models', {
			headers: JSON_FETCH,
			cookies: { 'hf-chat': '0b9f4d52-6a8e-4f1c-9a43-2f6d8c1e7a10' }
		});
		expect(response.status).toBe(308);
	});
});

describe.skipIf(!SITE_CODE)('site-only: boot and the error and fetch hooks', () => {
	it("checks the site's own env at boot, with neither chat's env check nor chat's server", async () => {
		vi.stubEnv('PUBLIC_ORIGIN', 'https://www.example.test');
		vi.stubEnv('PUBLIC_CMS_PAYLOAD_URL', 'https://cms.example.test');
		const { init } = await import('./hooks.server');
		await init();
		expect(validateEnv).not.toHaveBeenCalled();
		expect(initServer).not.toHaveBeenCalled();
	});

	it("refuses to boot production's site-only build without the CMS origin", async () => {
		vi.stubEnv('PUBLIC_ORIGIN', 'https://www.example.test');
		vi.stubEnv('PUBLIC_CMS_PAYLOAD_URL', '');
		const { init } = await import('./hooks.server');
		await expect(init()).rejects.toThrow(/PUBLIC_CMS_PAYLOAD_URL/);
		expect(initServer).not.toHaveBeenCalled();
	});

	it('never opens chat’s database pool when the server bundle loads', async () => {
		await import('./hooks.server');
		expect(preconnectDb).not.toHaveBeenCalled();
	});

	it("hands a /chat error and a /chat fetch to the site's own handlers, not chat's", async () => {
		const { handleError, handleFetch } = await import('./hooks.server');
		const url = new URL('https://www.example.test/chat/x');
		await handleError({
			error: new Error('x'),
			status: 500,
			message: 'Internal Error',
			event: { url, route: { id: null }, request: new Request(url) }
		} as never);
		expect(handleServerError).not.toHaveBeenCalled();
		const fetchImpl = vi.fn(async () => new Response('ok'));
		await handleFetch({
			event: { url },
			request: new Request('https://example.org/'),
			fetch: fetchImpl
		} as never);
		expect(handleFetchRequest).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalled();
	});
});
