// e2e-product: @chat
// e2e-area: @composer @history
//
// A chat-surface deployment (APP_SURFACE=chat, the alpha project) serves chat at the root of
// its host. Tagged @root, so only a run with SCENARIO_CHAT_SURFACE=1 against such a deployment (e.g.
// SCENARIO_BASE_URL=https://alpha-develop.aipotluck.org) collects it; every site-surface run, where
// chat lives under /chat, leaves it out (playwright.config.ts EXCLUDED_TAGS).
import { test, expect } from './helpers/test';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { turnDone } from './helpers/turn';

test.describe('chat at the root of a chat-surface host', { tag: '@root' }, () => {
	test('the root opens the composer, a sent turn lives at /conversation/<id>, and a reload keeps it', async ({
		page
	}) => {
		// Room for the 30 s composer wait, a 90 s turn and the reload's 30 s, with slack.
		test.setTimeout(180_000);
		await page.goto('/', { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await expect(composer).toBeVisible({ timeout: 30_000 });
		// Served at the root itself, not a redirect into /chat.
		expect(new URL(page.url()).pathname).toBe('/');

		await composerHydrated(page);
		const prompt = 'Reply with the single word: hello';
		await composer.fill(prompt);
		const id = await sendOpensConversation(page);
		expect(new URL(page.url()).pathname, 'the conversation URL carries no /chat prefix').toBe(
			`/conversation/${id}`
		);

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer)).toBeVisible({ timeout: 90_000 });

		await page.reload();
		expect(new URL(page.url()).pathname).toBe(`/conversation/${id}`);
		await expect(
			page.locator('[data-message-type="user"]').filter({ hasText: prompt })
		).toBeVisible({
			timeout: 30_000
		});
	});

	test('an old /chat page address 308s to the same path at the root, keeping the query', async ({
		page,
		request
	}) => {
		const res = await request.get('/chat/settings?from=bookmark', { maxRedirects: 0 });
		expect(res.status()).toBe(308);
		expect(res.headers()['location']).toBe('/settings?from=bookmark');

		// A leaf page, since /settings itself sends a desktop browser on to its first tab.
		await page.goto('/chat/settings/personalization');
		expect(new URL(page.url()).pathname).toBe('/settings/personalization');
	});

	test("a site page 308s to the same path on the site's host, since this host serves only chat", async ({
		request
	}) => {
		const res = await request.get('/map?from=alpha', { maxRedirects: 0 });
		expect(res.status()).toBe(308);
		// www for a production deployment, develop.aipotluck.org for a preview one like alpha-develop.
		expect(res.headers()['location']).toMatch(
			/^https:\/\/(www|develop)\.aipotluck\.org\/map\?from=alpha$/
		);
	});

	test('reserved /chat paths answer in place, never redirected: the API and the healthcheck', async ({
		request
	}) => {
		const models = await request.get('/chat/api/models', { maxRedirects: 0 });
		expect(models.status()).toBe(200);
		expect(Array.isArray(await models.json())).toBe(true);

		const health = await request.get('/chat/healthcheck', { maxRedirects: 0 });
		expect(health.status()).toBe(200);
	});

	test('static files resolve as themselves at the root, never as a chat route', async ({
		request
	}) => {
		const icon = await request.get('/chatui/favicon.svg', { maxRedirects: 0 });
		expect(icon.status()).toBe(200);
		expect(icon.headers()['content-type']).toContain('image/svg+xml');

		const llms = await request.get('/llms.txt', { maxRedirects: 0 });
		expect(llms.status()).toBe(200);
		expect(llms.headers()['content-type']).toContain('text/plain');
	});
});
