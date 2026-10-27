import { describe, expect, it } from 'vitest';
import {
	AUTH_BASE_PATH,
	CHAT_RESERVED_PATHS,
	CIMD_PATH,
	HF_LOGIN_CALLBACK_PATH,
	base,
	chatHome,
	chatSurfaceRedirect,
	chatSurfaceSiteRedirect,
	sitePageHref
} from './paths';

// Reserved means served in place on the chat surface: a GET there is never redirected.
const isChatReservedPath = (p: string) =>
	p.startsWith('/chat') && chatSurfaceRedirect(p, 'GET', 'chat') === null;

describe('base on the default (site) build', () => {
	it('stays /chat, so www, develop and PR previews build every chat URL exactly as before', () => {
		expect(base).toBe('/chat');
		expect(chatHome).toBe('/chat');
	});
});

// These are registered with Google, GitHub, Hugging Face and the sync clients, so they must
// read the same whichever surface built them. (CUR-4448)
describe('pinned auth paths', () => {
	it('keep their /chat prefix regardless of surface', () => {
		expect(AUTH_BASE_PATH).toBe('/chat/api/auth');
		expect(HF_LOGIN_CALLBACK_PATH).toBe('/chat/login/callback');
		expect(CIMD_PATH).toBe('/chat/.well-known/oauth-cimd');
	});

	it('are all reserved, so the chat surface serves them in place', () => {
		for (const p of [AUTH_BASE_PATH, HF_LOGIN_CALLBACK_PATH, CIMD_PATH]) {
			expect(isChatReservedPath(p), p).toBe(true);
		}
	});
});

describe('the reserved paths', () => {
	it('covers each reserved prefix and everything under it', () => {
		expect(CHAT_RESERVED_PATHS).toEqual([
			'/chat/api',
			'/chat/.well-known',
			'/chat/login/callback',
			'/chat/healthcheck',
			'/chat/guest-handoff'
		]);
		for (const p of [
			'/chat/api/models',
			'/chat/api/auth/callback/google',
			'/chat/api/cleanup',
			'/chat/api/warm',
			'/chat/.well-known/oauth-cimd',
			'/chat/login/callback',
			'/chat/healthcheck',
			'/chat/guest-handoff'
		]) {
			expect(isChatReservedPath(p), p).toBe(true);
		}
	});

	it('matches at a segment boundary, so /chat/login and /chat/apis are not reserved', () => {
		for (const p of ['/chat', '/chat/login', '/chat/apis', '/chat/healthchecker', '/chat/settings']) {
			expect(isChatReservedPath(p), p).toBe(false);
		}
	});
});

describe('chatSurfaceRedirect (the 308 for an old /chat address on the chat surface)', () => {
	const move = (p: string, method = 'GET') => chatSurfaceRedirect(p, method, 'chat');

	it('strips /chat from a GET or HEAD of a non-reserved chat page', () => {
		expect(move('/chat')).toBe('/');
		expect(move('/chat/')).toBe('/');
		expect(move('/chat/settings')).toBe('/settings');
		expect(move('/chat/conversation/abc', 'HEAD')).toBe('/conversation/abc');
		expect(move('/chat/login')).toBe('/login');
	});

	it('never moves a reserved path, so callbacks, crons, monitors and API clients answer in place', () => {
		for (const p of [
			'/chat/api/models',
			'/chat/api/auth/callback/github',
			'/chat/.well-known/oauth-cimd',
			'/chat/login/callback',
			'/chat/healthcheck',
			'/chat/guest-handoff'
		]) {
			expect(move(p), p).toBeNull();
		}
	});

	it('never moves a POST or any other method, whose body a redirect could drop', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			expect(move('/chat/conversation/abc', method), method).toBeNull();
		}
	});

	it('leaves paths outside /chat alone, /chatui included', () => {
		expect(move('/settings')).toBeNull();
		expect(move('/chatui/favicon.svg')).toBeNull();
		expect(move('/')).toBeNull();
	});

	it('does nothing at all on the site surface, where /chat is where chat lives', () => {
		expect(chatSurfaceRedirect('/chat/settings', 'GET', 'site')).toBeNull();
		expect(chatSurfaceRedirect('/chat', 'GET', 'site')).toBeNull();
		expect(chatSurfaceRedirect('/chat/settings', 'GET')).toBeNull();
	});
});

// routeId is what SvelteKit matched after `reroute` mapped the path into /chat. A site page
// matches the site's `[...slug]` catch-all there (or nothing at all); a chat page matches a chat route. (CUR-4448)
describe('chatSurfaceSiteRedirect (a site page on the chat surface goes to the site host)', () => {
	const site = (
		pathname: string,
		routeId: string | null,
		{ method = 'GET', search = '', vercelEnv = 'production' as string | undefined } = {}
	) => chatSurfaceSiteRedirect({ pathname, search, method, routeId, vercelEnv }, 'chat');

	it('sends an unmatched site path to www in production, keeping path and query', () => {
		expect(site('/map', '/[...slug]', { search: '?layer=data' })).toBe(
			'https://www.aipotluck.org/map?layer=data'
		);
		expect(site('/about/the-potluck-metaphor', '/[...slug]')).toBe(
			'https://www.aipotluck.org/about/the-potluck-metaphor'
		);
		expect(site('/sitemap.xml', '/[...slug]')).toBe('https://www.aipotluck.org/sitemap.xml');
		expect(site('/alpha', null, { method: 'HEAD' })).toBe('https://www.aipotluck.org/alpha');
	});

	it('sends it to develop.aipotluck.org from a preview deployment or with no VERCEL_ENV', () => {
		expect(site('/map', '/[...slug]', { vercelEnv: 'preview' })).toBe(
			'https://develop.aipotluck.org/map'
		);
		// Called directly: a destructuring default would turn `vercelEnv: undefined` back into production.
		expect(
			chatSurfaceSiteRedirect(
				{ pathname: '/map', search: '', method: 'GET', routeId: null, vercelEnv: undefined },
				'chat'
			)
		).toBe('https://develop.aipotluck.org/map');
	});

	it('never moves a matched chat route, even one that 404s itself (an unknown conversation id)', () => {
		expect(site('/', '/chat')).toBeNull();
		expect(site('/settings', '/chat/settings/(nav)')).toBeNull();
		expect(site('/conversation/not-a-real-id', '/chat/conversation/[id]')).toBeNull();
	});

	it('never moves a POST or any other method, whose body a redirect could drop', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			expect(site('/map', '/[...slug]', { method }), method).toBeNull();
		}
	});

	it("never moves chat's API at /api or the reserved /chat/api, even when nothing matched", () => {
		expect(site('/api/not-a-route', null)).toBeNull();
		expect(site('/api/favicon', '/[...slug]')).toBeNull();
		expect(site('/chat/api/not-a-route', null)).toBeNull();
	});

	it('never moves an old /chat address (chatSurfaceRedirect handles those) or a root static path', () => {
		expect(site('/chat/map', '/[...slug]')).toBeNull();
		expect(site('/_app/immutable/missing.js', null)).toBeNull();
		expect(site('/missing.png', null)).toBeNull();
	});

	it('does nothing at all on the site surface, where the site is served in place', () => {
		const req = {
			pathname: '/map',
			search: '',
			method: 'GET',
			routeId: null,
			vercelEnv: 'production'
		};
		expect(chatSurfaceSiteRedirect(req, 'site')).toBeNull();
		expect(chatSurfaceSiteRedirect(req)).toBeNull();
	});
});

// ChatShell links manifest.json on the site surface and manifest-root.json on the chat surface.
describe('the installed-app manifests', () => {
	it('differ only in start_url, each opening chat home on its own surface', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const read = (name: string) =>
			JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'static', 'chatui', name), 'utf8'));
		const site = read('manifest.json');
		const root = read('manifest-root.json');
		expect(site.start_url).toBe('/chat');
		expect(root.start_url).toBe('/');
		expect({ ...root, start_url: site.start_url }).toEqual(site);
	});
});

describe('sitePageHref (a chat route handing off to a site page never redirects to itself)', () => {
	it('on the chat surface, names the site host, because the bare path is the chat route itself', () => {
		expect(sitePageHref('/privacy-notice', 'production', 'chat')).toBe(
			'https://www.aipotluck.org/privacy-notice'
		);
		expect(sitePageHref('/trust-and-safety', 'preview', 'chat')).toBe(
			'https://develop.aipotluck.org/trust-and-safety'
		);
	});
	it('on the site surface, stays the bare path, where the CMS page answers it', () => {
		expect(sitePageHref('/privacy-notice', 'production', 'site')).toBe('/privacy-notice');
	});
});
