// e2e-product: @chat
// e2e-area: @models
import { expect, test } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';

// CUR-4692: the Language panel used to name the served model with the highest language score, so it
// showed GLM for Pashto and Apertus for English — pairings Auto never makes. It now asks `route()`.
// The pairing is on `data-auto-pick` / `data-model` (catalog ids), not the cycling line, so the check
// does not wait on the 2.6s rotation.

test(
	'the Language panel names Auto’s pick: not GLM for Pashto, not Apertus for English, GLM for Chinese',
	{ tag: ['@preview-only', '@CUR-4692'] },
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
			panel.locator('[data-auto-pick="pbt"]'),
			'Pashto named GLM, which Auto never picks'
		).not.toHaveAttribute('data-model', 'glm-5.2');
		await expect(
			panel.locator('[data-auto-pick="eng"]'),
			'English named Apertus, which Auto never picks for a typical message'
		).not.toHaveAttribute('data-model', 'apertus-70b');
		await expect(
			panel.locator('[data-auto-pick="cmn"]'),
			'Chinese did not name GLM'
		).toHaveAttribute('data-model', 'glm-5.2');
	}
);
