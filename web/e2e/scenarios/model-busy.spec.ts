// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { listedModels } from './helpers/servedModel';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// When the default model's host answers 429 (CUR-2307; a preview key is capped at 30 requests
// a minute, shared by every preview), the turn must not end with "429 Rate limit exceeded"
// in the bubble. The `lane_rate_limited` fault throws that same error from the answer's endpoint call
// on this one request, so the visitor sees what a real over-cap turn gives them.
// Preview-only: the fault switch is never armed on production (faultInjection.ts).
test(
	'a model over its rate cap ends the turn with busy copy naming the model and a Retry, not raw 429 text',
	{ tag: ['@F2', '@C3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const models = await listedModels(page.request);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'lane_rate_limited');
		await page.goto('/chat', { waitUntil: 'commit' });

		await journeyStep(page, 'C3', 2, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			// No maths: a maths question can route to a different model than the default (CUR-2198).
			await composer.fill('What is the capital of Switzerland?');
			await composer.press('Enter');
			await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const reply = page.locator('[data-message-role="assistant"]').last();
			const busy = reply.getByText(/ is busy right now/);
			await expect(
				busy,
				'the failed turn does not say the model is busy; if it shows "429 Rate limit exceeded" the copy is not wired, and if it answered, the fault never reached the server'
			).toBeVisible({ timeout: 60_000 });
			// With Auto on, the turn goes to whichever model Auto routed it to, not the first listed one
			// (CUR-3923), so the copy has to name one of the listed models, not a fixed one.
			const named = ((await busy.textContent()) ?? '').split(' is busy right now')[0].trim();
			expect(
				models.map((m) => m.displayName),
				`the busy copy names "${named}", which is no model this deployment lists`
			).toContain(named);
			await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
			await expect(reply, 'the raw SDK text still reaches the visitor').not.toContainText(
				'429 Rate limit exceeded'
			);
			// Our own send limit says "too many messages", which would blame the visitor for the provider's cap.
			await expect(page.getByText(/too many messages/i)).toHaveCount(0);
		});
	}
);
