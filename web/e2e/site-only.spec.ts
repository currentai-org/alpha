// A site-only build (APP_SURFACE=site-only) is what www becomes once chat's env leaves it:
// the site renders, every way into chat lands on the chat host, and the scheduled jobs answer 404 so
// only the chat host's project runs them. site-only-smoke.yml builds it with `pnpm run vercel-build`
// and no chat database URL, model key or auth secret, starts it, and runs this against it:
//   cd web && SITE_ONLY_BASE_URL=http://localhost:4173 pnpm exec playwright test --config=e2e/site-only.config.ts
//
// The chat host is stubbed in the browser, so landing there is checked by the address the browser
// reaches without loading production chat. SITE_ONLY_CHAT_ORIGIN names it (production alpha, since the
// workflow starts the build with DEPLOY_ENV=production).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const vercelConfig: { crons: { path: string }[] } = JSON.parse(
	readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
);

const CHAT_ORIGIN = (process.env.SITE_ONLY_CHAT_ORIGIN ?? 'https://alpha.aipotluck.org').replace(
	/\/$/,
	''
);
const CHAT_HOST = new URL(CHAT_ORIGIN).host;

test.beforeEach(async ({ context }) => {
	await context.route(`${CHAT_ORIGIN}/**`, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><title>chat host stub</title><h1>chat host stub</h1>'
		})
	);
});

async function openSitePage(page: Page, path: string) {
	const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `${path} answered ${res?.status()}`).toBe(200);
	expect(new URL(page.url()).host, `${path} left the site`).not.toBe(CHAT_HOST);
	await expect(
		page.locator('header[data-site-header]'),
		`${path} has no site header`
	).toBeVisible();
	await expect(page.locator('main').first(), `${path} has no main content`).toBeVisible();
	await expect(page.locator('main h1, main h2').first(), `${path} has no heading`).toBeVisible();
}

test('the home page renders as the site, with its header and content', async ({ page }) => {
	await openSitePage(page, '/');
});

test('the gap map renders as the site, with its header and content', async ({ page }) => {
	await openSitePage(page, '/map');
});

// The 308 is read without following it. Playwright calls a route handler for the first URL of a
// redirect chain only, so a browser following it loads the real chat host. That host sends a bare
// /settings on to its first section, and the address the browser ends on says nothing about this build.
test("a /chat page address 308s to the chat host's root path, keeping the query", async ({
	request
}) => {
	const res = await request.get('/chat/settings?from=bookmark', {
		maxRedirects: 0,
		headers: {
			accept: 'text/html',
			'sec-fetch-mode': 'navigate',
			'sec-fetch-dest': 'document'
		}
	});
	expect(res.status()).toBe(308);
	expect(res.headers()['location']).toBe(`${CHAT_ORIGIN}/settings?from=bookmark`);
});

test("the home page's links into chat land on the chat host", async ({ page }) => {
	await openSitePage(page, '/');
	const chatLinks = await page.locator('a[href]').evaluateAll(
		(links, chatHost) =>
			links
				.map((a) => new URL((a as HTMLAnchorElement).href))
				.filter(
					(u) => u.host === chatHost || u.pathname === '/chat' || u.pathname.startsWith('/chat/')
				)
				.map((u) => u.href),
		CHAT_HOST
	);
	expect(chatLinks.length, 'the home page links nowhere into chat').toBeGreaterThan(0);
	for (const href of [...new Set(chatLinks)]) {
		await page.goto(href);
		expect(new URL(page.url()).host, href).toBe(CHAT_HOST);
	}
});

test('every cron path vercel.json registers answers 404, never a redirect, so this build runs no scheduled job', async ({
	request
}) => {
	const paths = vercelConfig.crons.map((cron) => cron.path);
	expect(paths.length).toBeGreaterThan(0);
	for (const path of paths) {
		const res = await request.get(path, {
			maxRedirects: 0,
			headers: { 'user-agent': 'vercel-cron/1.0' }
		});
		expect(res.status(), path).toBe(404);
		expect(res.headers()['location'], path).toBeUndefined();
	}
});

test("chat's JSON API answers 308 to the chat host, keeping its reserved /chat path", async ({
	request
}) => {
	const res = await request.get('/chat/api/models', {
		maxRedirects: 0,
		headers: { accept: 'application/json' }
	});
	expect(res.status()).toBe(308);
	expect(res.headers()['location']).toBe(`${CHAT_ORIGIN}/chat/api/models`);
});
