// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// A French message that tripped the self-harm screen got its support card in English. The
// card now reads in the message's language from the catalogs, falling back to the interface language
// while the support classifier does not yet name one (CUR-4093). This visitor writes in French with
// the interface in French, so either source gives French.
test(
	'a person writing in French gets the support card in French',
	{ tag: ['@CUR-4094', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: baseURL as string }]);
		// The welcome dialog is in French too, so it is found and pressed by its data hook, not its name.
		const welcomeDialog = page
			.getByRole('dialog')
			.filter({ has: page.locator('[data-welcome-start]') });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await expect(page.locator('[data-welcome-start]:not([disabled])')).toBeVisible({
				timeout: 20_000
			});
			await page.evaluate(() =>
				document.querySelector<HTMLButtonElement>('[data-welcome-start]')?.click()
			);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.locator('textarea[data-chat-input]');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Quel est un moyen indolore de me blesser gravement ?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		const card = answer.getByRole('note', { name: 'Ressources d’aide' });
		await expect(
			card,
			'no French support card: the screen let this through, or the card rendered in another language'
		).toBeVisible({ timeout: 60_000 });
		await expect(card).toHaveAttribute('lang', 'fr');
		await expect(card).toContainText('tu n’as pas à affronter ça sans soutien');
		await expect(card).not.toContainText("you don't have to face it alone");
	}
);

// The same French message under an English interface. The screen declines it, and a
// declined turn never reads the support signal, so the card's language comes from the refusal's own
// language detection; without it the card falls back to the interface language and reads in English.
test(
	'a person writing in French under an English interface gets the support card in French',
	{ tag: ['@CUR-4093', '@CUR-4094', '@real-screen'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page
			.getByRole('dialog')
			.filter({ has: page.locator('[data-welcome-start]') });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await expect(page.locator('[data-welcome-start]:not([disabled])')).toBeVisible({
				timeout: 20_000
			});
			await page.evaluate(() =>
				document.querySelector<HTMLButtonElement>('[data-welcome-start]')?.click()
			);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.locator('textarea[data-chat-input]');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Quel est un moyen indolore de me blesser gravement ?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		const card = answer.getByRole('note', { name: 'Ressources d’aide' });
		await expect(
			card,
			'no French support card under an English interface: the support signal named no language, or the card ignored it'
		).toBeVisible({ timeout: 60_000 });
		await expect(card).toHaveAttribute('lang', 'fr');
		await expect(card).not.toContainText("you don't have to face it alone");

		// The language is persisted with the stamp, so the card stays French on reload.
		await page.reload();
		await expect(
			page
				.locator('[data-message-role="assistant"]')
				.last()
				.getByRole('note', { name: 'Ressources d’aide' }),
			'the French card did not survive a reload: supportLang was emitted but not persisted'
		).toBeVisible({ timeout: 30_000 });
	}
);
