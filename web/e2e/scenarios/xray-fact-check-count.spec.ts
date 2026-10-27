// e2e-product: @chat
// e2e-area: @provenance
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';

const START_CHATTING = /start chatting/i;

// When the fact check removes claims no source supports, X-ray's "Step by step"
// says how many, and nothing under the answer does (CUR-2927). `groundcheck_removes_claim` streams the canned reply
// and runs groundcheck on it with a stub detector and reviser that delete one word, so the count comes
// from the real acceptance guards and the stamp the route saves, with no model or detector call. The
// row is read after a reload, so it comes from the stored message rather than the live stream.
test(
	'X-ray’s fact check step says how many claims were removed from the answer',
	{ tag: ['@F2', '@CUR-2927', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.getByRole('button', { name: START_CHATTING }).click();
		});
		await installFaultInjectionHeader(page, 'groundcheck_removes_claim');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is a canned reply?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the answer never finished').toBeVisible({ timeout: 60_000 });
		await expect(answer, 'the fact check did not delete the claim').toContainText(
			'This is a reply: no model wrote it.'
		);

		await page.reload();
		const saved = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(saved)).toBeVisible({ timeout: 30_000 });
		await expect(saved, 'the saved answer is not the checked one').toContainText(
			'This is a reply: no model wrote it.'
		);
		// X-ray opens from the composer's pill, which shows the latest answer.
		await page
			.getByRole('button', { name: 'X-ray — see what happened behind the answer' })
			.click({ timeout: 30_000 });
		await page.getByRole('tab', { name: 'Step by step' }).click({ timeout: 10_000 });
		const factCheck = page.locator('[data-xray-steps] [data-step-id="factcheck"]');
		await expect(factCheck, 'X-ray shows no fact check step').toBeVisible({ timeout: 10_000 });
		await expect(factCheck, 'the fact check step does not give the count').toContainText(
			'Removed 1 claim no source supports.'
		);
	}
);
