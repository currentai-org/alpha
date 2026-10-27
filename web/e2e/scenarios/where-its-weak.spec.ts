// e2e-product: @chat
// e2e-area: @turn
// The "?" under an answer opens "Where it's weak" (CUR-4262). Two of its sections described an older
// Alpha: "a single open model generates every answer" (Auto now picks between several models) and
// "turn Web search on in the + menu" (web search is automatic by default). A visitor sends a message,
// opens the "?" under the answer, and reads limits that match the product today.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installCannedReplies } from './helpers/faultInjection';

test(
	'the "?" under an answer describes today\'s Alpha: several models answer, and web search needs no switch',
	{ tag: ['@F3', '@CUR-4262'] },
	async ({ page }) => {
		// Sends a real turn and waits up to 90s for it, after up to 60s of setup.
		test.setTimeout(180_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of France in one short sentence.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const trigger = page.getByRole('button', { name: "Where it's weak", exact: true }).first();
		await expect(trigger, 'no "?" under the answer opens "Where it\'s weak"').toBeVisible({
			timeout: 90_000
		});
		await trigger.click();
		const dialog = page.getByRole('dialog').filter({
			has: page.getByRole('heading', { name: "Where it's weak" })
		});
		await expect(dialog).toBeVisible();

		await expect(dialog).toContainText(
			'Different open models answer different messages. The model and its sources are named under each answer, so you can check them.'
		);
		await expect(dialog).toContainText(
			'When a question needs recent facts, Alpha searches the web and lists its sources'
		);
		await expect(
			dialog,
			'the dialog still says one model answers everything, though Auto picks between several'
		).not.toContainText('single open model');
		await expect(
			dialog,
			'the dialog still sends people to the + menu for a web search switch they do not need'
		).not.toContainText('+ menu');
	}
);
