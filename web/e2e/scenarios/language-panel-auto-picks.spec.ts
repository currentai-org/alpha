// e2e-product: @chat
// e2e-area: @models
import { expect, test } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';

// the Language panel used to name the served model with the highest language score, so it
// showed GLM for Pashto and Apertus for English — pairings Auto never makes. It now asks `route()`.
// The pairing is on `data-auto-pick` / `data-model` (catalog ids), not the cycling line, so the check
// does not wait on the 2.6s rotation.

test(
	'the Language panel names Auto’s pick: not Apertus for English, Mistral Medium for Chinese, SEA-LION v4.8 for Indonesian',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog
				.getByRole('button', { name: /start chatting|^skip$/i })
				.first()
				.click();
		});
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		await page.getByRole('button', { name: 'Language: how Alpha picks a model for yours' }).click();
		const panel = page.locator('[data-language-support-panel]');
		await expect(panel).toBeVisible({ timeout: 15_000 });

		await expect(
			panel.locator('[data-auto-pick="eng"]'),
			'English named Apertus, which Auto never picks for a typical message'
		).not.toHaveAttribute('data-model', 'apertus-70b');
		await expect(
			panel.locator('[data-auto-pick="cmn"]'),
			'Chinese did not name Mistral Medium, which no served model is scoped above for it'
		).toHaveAttribute('data-model', 'mistral-medium');
		await expect(
			panel.locator('[data-auto-pick="ind"]'),
			'Indonesian did not name SEA-LION v4.8, Auto’s pick for it'
		).toHaveAttribute('data-model', 'sea-lion-nemotron-120b');
	}
);
