// e2e-product: @chat
// e2e-area: @settings
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { accountMenuItem } from './helpers/accountMenu';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { startChattingPastWelcome } from './helpers/welcome';

// "Give feedback" sits beside "Report a problem" in the account menu's Help group and opens
// the feedback form (Tally) in a new tab. Report is for what is broken; feedback is "I liked this" or "I
// wish it did that", so the two stay separate entries. Walked as a guest and signed in, the two ways
// a visitor meets the menu (CUR-2890).

const TALLY = /^https:\/\/tally\.so\//;

async function openFeedbackForm(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

	const feedback = await accountMenuItem(page, 'Give feedback', { timeout: 30_000 });
	await expect(
		page.getByRole('menuitem', { name: 'Report a problem' }),
		'"Give feedback" showed without "Report a problem" beside it'
	).toBeVisible();
	await expect(
		feedback,
		'the entry would replace the chat instead of opening a new tab'
	).toHaveAttribute('target', '_blank');

	const [form] = await Promise.all([page.waitForEvent('popup'), feedback.click()]);
	await expect
		.poll(() => form.url(), { message: 'the new tab is not the Tally form' })
		.toMatch(TALLY);
	await expect(page, 'the chat tab navigated away').toHaveURL(/\/chat/);
}

test(
	'a guest opens the Tally feedback form from "Give feedback" beside "Report a problem"',
	{
		tag: '@A5'
	},
	async ({ page }) => {
		test.setTimeout(60_000);
		await openFeedbackForm(page);
	}
);

test(
	'a signed-in visitor opens the same feedback form from the account menu',
	{
		tag: ['@A5', '@preview-only']
	},
	async ({ page }) => {
		test.setTimeout(120_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');
		await signInWithEmailOtp(page, databaseUrl, freshTestEmail());
		await openFeedbackForm(page);
	}
);
