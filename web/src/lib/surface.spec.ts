import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SURFACE, chatRoutePath, isChatRoute } from './surface';

// Resolves as itself on the chat surface, rather than as a chat route.
const isChatSurfaceRootPath = (p: string) => chatRoutePath(p, 'chat') === p;

const WEB = join(__dirname, '..', '..');

// `reroute` (hooks.ts) is chatRoutePath on the unlocalized path. (CUR-4448)
describe('chatRoutePath on the site surface', () => {
	it('is the identity for every path, so www, develop and PR previews route exactly as before', () => {
		for (const p of [
			'/',
			'/chat',
			'/chat/settings',
			'/settings',
			'/api/models',
			'/map',
			'/alpha/demo'
		]) {
			expect(chatRoutePath(p, 'site')).toBe(p);
		}
	});

	it('is the surface every build without APP_SURFACE gets, including this test run', () => {
		expect(APP_SURFACE).toBe('site');
	});
});

describe('chatRoutePath on the chat surface', () => {
	const route = (p: string) => chatRoutePath(p, 'chat');

	it('maps the root and every chat page onto the /chat route tree', () => {
		expect(route('/')).toBe('/chat');
		expect(route('/settings')).toBe('/chat/settings');
		expect(route('/settings/storage')).toBe('/chat/settings/storage');
		expect(route('/conversation/abc')).toBe('/chat/conversation/abc');
		expect(route('/conversation/abc/output/a.mp4')).toBe('/chat/conversation/abc/output/a.mp4');
		expect(route('/models/swiss-ai/Apertus')).toBe('/chat/models/swiss-ai/Apertus');
		expect(route('/healthcheck')).toBe('/chat/healthcheck');
	});

	it("maps chat's API at /api onto the same handlers as the reserved /chat/api", () => {
		expect(route('/api/models')).toBe('/chat/api/models');
		expect(route('/api/v2/user/settings')).toBe('/chat/api/v2/user/settings');
		expect(route('/api/auth/sign-in/social')).toBe('/chat/api/auth/sign-in/social');
	});

	it('leaves a path already under /chat as itself (reserved paths, and old links before their 308)', () => {
		for (const p of [
			'/chat',
			'/chat/api/models',
			'/chat/healthcheck',
			'/chat/.well-known/oauth-cimd'
		]) {
			expect(route(p)).toBe(p);
		}
	});

	it('keeps the shared root paths resolving as themselves, never as a chat route', () => {
		for (const p of [
			'/_app/immutable/entry/start.js',
			'/_app/remote/abc',
			'/.well-known/oauth-authorization-server/chat/api/auth',
			'/rs/e/',
			'/folkways-adapter/v1/chat/completions',
			'/api/cms/invalidate',
			'/favicon.ico',
			'/llms.txt',
			'/robots.txt',
			'/chatui/favicon.svg',
			'/data/catalog.json',
			'/fonts/x.woff2'
		]) {
			expect(route(p), p).toBe(p);
		}
	});

	it("routes the site's pages and sitemap into chat (a 404 there), never serving site pages on chat's host", () => {
		expect(route('/sitemap.xml')).toBe('/chat/sitemap.xml');
		expect(route('/alpha')).toBe('/chat/alpha');
		expect(route('/org/hugging-face')).toBe('/chat/org/hugging-face');
		expect(route('/api/favicon')).toBe('/chat/api/favicon');
	});

	it('matches root prefixes at a segment boundary only', () => {
		expect(route('/rsvp')).toBe('/chat/rsvp');
		expect(route('/api/cmsx')).toBe('/chat/api/cmsx');
		expect(route('/chatui-old')).toBe('/chat/chatui-old');
	});
});

describe('isChatRoute', () => {
	it('is /chat and below on the site surface, and not /chatui', () => {
		expect(isChatRoute('/chat', 'site')).toBe(true);
		expect(isChatRoute('/chat/settings', 'site')).toBe(true);
		expect(isChatRoute('/settings', 'site')).toBe(false);
		expect(isChatRoute('/chatui/x.svg', 'site')).toBe(false);
		expect(isChatRoute(undefined, 'site')).toBe(false);
	});

	it('is every rerouted path on the chat surface, and none of the shared root ones', () => {
		expect(isChatRoute('/', 'chat')).toBe(true);
		expect(isChatRoute('/settings', 'chat')).toBe(true);
		expect(isChatRoute('/chat/api/models', 'chat')).toBe(true);
		expect(isChatRoute('/rs/e/', 'chat')).toBe(false);
		expect(isChatRoute('/favicon.ico', 'chat')).toBe(false);
	});
});

// The CDN serves web/static before any function runs; if reroute mapped one of these into chat, a
// client-side navigation to it would look for a chat route instead of loading the file.
describe('web/static on the chat surface', () => {
	it('every top-level static file and directory resolves as itself (add a new directory to STATIC_ROOT_DIRS in surface.ts)', () => {
		const entries = readdirSync(join(WEB, 'static')).filter((name) => !name.startsWith('.'));
		expect(entries.length).toBeGreaterThan(5);
		for (const name of entries) {
			const isDir = statSync(join(WEB, 'static', name)).isDirectory();
			const probe = isDir ? `/${name}/probe.png` : `/${name}`;
			expect(isChatSurfaceRootPath(probe), probe).toBe(true);
		}
	});

	it('no chat route segment shares a name with a static directory or looks like a root file', () => {
		// `.well-known` is the exception, deliberately: chat's own (`/chat/.well-known`, the CIMD) is a
		// reserved path reached only by its pinned `/chat` address, and the root one is RFC 8414's.
		const chatRoutes = readdirSync(join(WEB, 'src', 'routes', 'chat')).filter(
			(name) =>
				name !== '.well-known' && statSync(join(WEB, 'src', 'routes', 'chat', name)).isDirectory()
		);
		expect(chatRoutes).toContain('settings');
		for (const name of chatRoutes) {
			expect(isChatSurfaceRootPath(`/${name}`), name).toBe(false);
		}
	});
});
