// e2e-product: @chat
// e2e-area: @history
import { test, expect, type Page } from './helpers/test';

// A2's recordings showed a French or Spanish visitor a French placeholder and status line
// inside English chrome: "New chat", "Search chats", the Get involved card, "Not signed in" and the
// "Deletes in 30 days" badge. Those now follow the browser's language through the interface
// catalogs (`messages/*.json`, CUR-2394). The English test is the control: it pins the labels the
// other specs and the gallery read.

async function openChat(page: Page) {
	const welcomeDialog = page.locator('[data-welcome]');
	await page.addLocatorHandler(welcomeDialog, async () => {
		await welcomeDialog.locator('[data-welcome-start]').click();
	});
	await page.goto('/chat', { waitUntil: 'commit' });
	// By its marker, not its label: the label is in the browser's language too.
	const composer = page.locator('[data-chat-input]');
	await composer.click({ timeout: 30_000 });
	return composer;
}

test.describe('the chrome in a French browser', () => {
	test.use({ locale: 'fr-FR' });

	test(
		'CUR-2866: a French browser gets the sidebar, Get involved card, account row and retention badge in French',
		{ tag: ['@CUR-2866', '@A2'] },
		async ({ page }) => {
			test.setTimeout(120_000);
			const composer = await openChat(page);

			await expect(page.getByRole('link', { name: /^Nouvelle conversation/ })).toBeVisible();
			await expect(page.getByRole('button', { name: /^Rechercher/ })).toBeVisible();
			const card = page.locator('[data-get-involved]');
			await expect(card.getByRole('heading', { name: 'Participe' })).toBeVisible();
			await expect(card.getByRole('link', { name: /Façons de contribuer/ })).toBeVisible();
			await expect(page.locator('[data-account-status]')).toHaveText('Non connecté');

			// The retention badge sits in a conversation's header, so it takes one turn to see.
			await composer.fill('Bonjour');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
			await expect(
				page.locator('[data-guest-retention]'),
				'the guest retention badge stayed English, or never showed'
			).toContainText(/Supprimé dans\s+\d+ jours/, { timeout: 30_000 });
			await expect(page.getByText('Deletes in')).toHaveCount(0);
		}
	);
});

test.describe('the chrome in an English browser', () => {
	test.use({ locale: 'en-US' });

	test(
		'CUR-2866: an English browser keeps the English sidebar labels the other specs read',
		{ tag: ['@CUR-2866', '@A2'] },
		async ({ page }) => {
			await openChat(page);
			await expect(page.getByRole('link', { name: /^New chat/ })).toBeVisible();
			await expect(page.getByRole('button', { name: /^Search chats/ })).toBeVisible();
			await expect(
				page.locator('[data-get-involved]').getByRole('heading', { name: 'Get involved' })
			).toBeVisible();
			await expect(page.locator('[data-account-status]')).toHaveText('Not signed in');
		}
	);
});
