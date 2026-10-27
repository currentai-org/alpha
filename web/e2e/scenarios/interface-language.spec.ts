// e2e-product: @chat @site
// e2e-area: @auth @settings
import { expect, test, type Page } from './helpers/test';

const languages = [
	{
		locale: 'es',
		name: 'Español',
		newChat: 'Nuevo chat',
		settings: 'Configuración',
		composer: 'Enviar un mensaje a AI Potluck'
	},
	{
		locale: 'fr',
		name: 'Français',
		newChat: 'Nouvelle conversation',
		settings: 'Paramètres',
		composer: 'Écrire à AI Potluck'
	},
	{
		locale: 'de',
		name: 'Deutsch',
		newChat: 'Neuer Chat',
		settings: 'Einstellungen',
		composer: 'Nachricht an AI Potluck'
	},
	{
		locale: 'en',
		name: 'English',
		newChat: 'New chat',
		settings: 'Settings',
		composer: 'Message AI Potluck'
	}
] as const;

async function showSidebar(page: Page) {
	const open = page.locator('[data-sidebar-open]');
	if (
		(page.viewportSize()?.width ?? 1280) < 768 &&
		!(await page.locator('aside[data-mobile-open]').count())
	)
		await open.click();
	await expect(page.locator('[data-account-trigger]:visible').first()).toBeVisible();
}

for (const viewport of [
	{ name: 'desktop', width: 1280, height: 900 },
	{ name: 'phone', width: 390, height: 844 }
]) {
	test.describe(`Interface language · ${viewport.name}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test('account language selection persists across reload and preserves the current draft and conversation while switching', async ({
			page,
			context,
			baseURL
		}) => {
			const runtimeErrors: string[] = [];
			page.on('pageerror', (error) => runtimeErrors.push(error.message));
			page.on('console', (message) => {
				if (message.type() === 'error' && /hydrat|HierarchyRequestError/i.test(message.text())) {
					runtimeErrors.push(message.text());
				}
			});
			await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: baseURL as string }]);
			// Enter through the public product, just as a first-time visitor does.
			await page.goto('/alpha');
			await page.locator('[data-hero-try-demo]').click();
			await expect(page).toHaveURL(/\/alpha\/demo/);
			const composer = page.locator('textarea[data-chat-input]');
			await expect(composer).toBeEditable();
			expect(runtimeErrors, 'public landing and demo entry hydrate without runtime errors').toEqual(
				[]
			);
			const draft = 'Keep this draft: café, mañana, Straße.';
			await composer.fill(draft);
			const messages = page.locator('[data-message-id]');
			await expect(messages.first()).toBeVisible();
			const conversation = await messages.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute('data-message-id'))
			);

			for (const language of languages) {
				await showSidebar(page);
				await page.locator('[data-account-trigger]:visible').first().click();
				await page.locator('[data-interface-language]').click();
				const choice = page.locator(`[data-interface-locale="${language.locale}"]`);
				await expect(choice).toHaveText(language.name);
				await expect(choice).toHaveAttribute('role', 'menuitemradio');
				await choice.click();
				await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
				await expect(
					page.getByRole('menuitem', { name: language.settings, exact: true })
				).toBeVisible();
				await expect(choice).toHaveAttribute('aria-checked', 'true');
				await expect(composer).toHaveAttribute('aria-label', language.composer);
				await expect(composer).toHaveValue(draft);
				await expect
					.poll(async () =>
						messages.evaluateAll((nodes) =>
							nodes.map((node) => node.getAttribute('data-message-id'))
						)
					)
					.toEqual(conversation);
				await expect
					.poll(
						async () =>
							(await context.cookies()).find((cookie) => cookie.name === 'PARAGLIDE_LOCALE')?.value
					)
					.toBe(language.locale);
				// Target the menu so Escape dismisses it without invoking the demo's exit shortcut.
				await page.getByRole('menuitem', { name: language.settings, exact: true }).press('Escape');
				await expect(page.locator('[data-interface-language]')).toBeHidden();
				await expect(page).toHaveURL(/\/alpha\/demo/);
				await expect(page.getByRole('link', { name: language.newChat, exact: true })).toBeVisible();
				// The home page is not translated, so it keeps its one English URL in every language.
				await expect(page.locator('[data-sidebar-home]:visible')).toHaveAttribute('href', '/');
			}

			// Switch once more so the reload proves a non-default language is saved.
			await showSidebar(page);
			await page.locator('[data-account-trigger]:visible').first().click();
			await page.locator('[data-interface-language]').click();
			await page.locator('[data-interface-locale="fr"]').click();
			await expect(composer).toHaveValue(draft);
			await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
			const response = await context.request.get('/alpha/demo');
			expect(response.ok()).toBe(true);
			expect(await response.text()).toMatch(/<html\b[^>]*lang="fr"/);
			await page.reload();
			await expect(composer).toHaveAttribute('aria-label', 'Écrire à AI Potluck');
			await showSidebar(page);
			await expect(
				page.getByRole('link', { name: 'Nouvelle conversation', exact: true })
			).toBeVisible();
			await page.locator('[data-sidebar-home]:visible').click();
			await expect(page).toHaveURL(new URL('/', baseURL).href);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
			expect(
				runtimeErrors,
				'language switches and reload preserve a healthy hydrated interface'
			).toEqual([]);
		});
	});
}

test('only translated public pages have language URLs', async ({ page, baseURL }) => {
	await page.goto('/fr/alpha');
	await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
	await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(5);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/fr\/alpha$/);
	// An untranslated page has no French copy: the prefixed URL lands on the English page.
	await page.goto('/fr/map');
	await expect(page).toHaveURL(new URL('/map', baseURL).href);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
});

test('the public page offers its own language switch', async ({ page, baseURL }) => {
	await page.goto('/alpha');
	// The trigger is server-rendered; retry until hydration has wired it and the menu opens.
	const openMenu = () =>
		expect(async () => {
			await page.locator('[data-page-options]').click();
			await expect(page.locator('[data-page-locale="en"]')).toBeVisible({ timeout: 1_000 });
		}).toPass();
	await openMenu();
	await page.locator('[data-page-locale="es"]').click();
	await expect(page).toHaveURL(new URL('/es/alpha', baseURL).href);
	await expect(page.locator('html')).toHaveAttribute('lang', 'es');
	await expect(page.locator('[data-page-options]')).toHaveText(/Español/);
	await openMenu();
	await page.locator('[data-page-locale="en"]').click();
	await expect(page).toHaveURL(new URL('/alpha', baseURL).href);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('switching the chat language translates the editable landing copy too', async ({
	page,
	context,
	baseURL
}) => {
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL as string }]);
	await page.goto('/chat');
	await expect(page.getByText('Public, ouvert, à but non lucratif.')).toBeVisible();
	await expect(page.getByText('Public, open, not for profit.')).toHaveCount(0);
});
