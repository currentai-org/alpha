// e2e-product: @site
// e2e-area: @auth @history
import { expect, test } from './helpers/test';

// The /alpha demo is retired. It was the real chat app fed sample data: a sidebar of made-up past
// chats in five languages under a "Demo" user, and a sign-up wall on send. A visitor demoing Alpha to
// a partner read it as other people's conversations and a login requirement, which the real app has
// neither of. Every way in now reaches the real chat, which a guest can use without signing in.

// Sidebar titles only the demo showed; none may render on the landing page or the chat again. Not the
// four in the "Your data" feature card (DataBento: "Tóm tắt ý kiến cư dân", "Bürgerbrief in Leichter
// Sprache"…), which illustrate the forget button beside it and are not a conversation list.
const DEMO_SAMPLE_TITLES = [
	'Convocatoria de subvenciones',
	'Warsztaty cyfrowe w bibliotece',
	'Accessibilità del sito comunale',
	'Helping Alpha learn a language'
];

test.describe('the retired /alpha demo', () => {
	test('/alpha/demo answers a permanent redirect to the real chat, not a demo page', async ({
		request
	}) => {
		for (const path of ['/alpha/demo', '/alpha/demo?look=classic']) {
			const response = await request.get(path, { maxRedirects: 0 });
			expect(response.status(), path).toBe(308);
			// www sends it to the chat host; develop and previews still serve /chat themselves.
			expect(response.headers()['location'], path).toMatch(
				/^(\/chat|https:\/\/alpha\.aipotluck\.org\/)$/
			);
		}
	});

	test('the /alpha page source ships none of the retired demo copy, even while the CMS still stores it', async ({
		request
	}) => {
		// Payload still holds the demo's button, stage and caption fields; the page schema drops them, so
		// they never reach the serialized page data a visitor's browser downloads.
		const html = await (await request.get('/alpha')).text();
		for (const copy of ['demoCta', 'interactLabel', 'interactHint', 'Click to use the demo'])
			expect(html, copy).not.toContain(copy);
	});

	test('the /alpha landing page shows none of the demo sample chats and offers no demo, only the real chat', async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: baseURL! }]);
		await page.goto('/alpha');
		await expect(page.locator('[data-hero-cta]')).toBeVisible();
		await expect(
			page.locator('[data-hero-try-demo], [data-try-demo], [data-alpha-demo]')
		).toHaveCount(0);
		await expect(page.locator('a[href*="/alpha/demo"]')).toHaveCount(0);
		const body = await page.locator('body').innerText();
		for (const title of DEMO_SAMPLE_TITLES) expect(body, title).not.toContain(title);

		// The one way in lands a first-time visitor in the real app as a guest with no history, and the
		// composer is theirs to use without signing in.
		await page.locator('[data-hero-cta]').click();
		await expect(page).toHaveURL(/\/chat\/?$/);
		await expect(
			page.getByText('Your conversations will appear here once you start chatting.').first()
		).toBeVisible();
		await expect(page.locator('textarea[data-chat-input]')).toBeEditable();
		const sidebar = await page.locator('body').innerText();
		for (const title of DEMO_SAMPLE_TITLES) expect(sidebar, title).not.toContain(title);
	});
});
