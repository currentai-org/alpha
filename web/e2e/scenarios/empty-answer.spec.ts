// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { listedModels } from './helpers/servedModel';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// A turn the lane accepts and answers with nothing used to end on "No output was generated.
// Something went wrong.", which named no model and offered no next step (five www turns in a week).
// The `no_assistant_reply` fault makes the server yield no content after the turn starts, which is the
// route's empty-generation branch. Preview-only: the fault switch is never armed on production.
test(
	'an answer that comes back empty names the model and offers Retry, not a bare "something went wrong"',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const models = await listedModels(page.request);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'no_assistant_reply');
		await page.goto('/chat', { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is the capital of Switzerland?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		const notice = reply.getByText(/ couldn't answer this time\. Press Retry to ask again\./);
		await expect(
			notice,
			'the empty turn does not end on the notice naming the model; if it reads "No output was generated" the copy is not wired, and if it answered, the fault never reached the server'
		).toBeVisible({ timeout: 60_000 });
		// With Auto on, the turn goes to whichever model Auto routed it to (CUR-3923), so the notice has
		// to name one of the listed models rather than a fixed one.
		const named = ((await notice.textContent()) ?? '').split(" couldn't answer")[0].trim();
		expect(
			models.map((m) => m.displayName),
			`the notice names "${named}", which is no model this deployment lists`
		).toContain(named);
		await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
		await expect(reply).not.toContainText('No output was generated');
	}
);
