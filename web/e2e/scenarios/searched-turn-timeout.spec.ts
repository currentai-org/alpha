// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Locator, type Page } from './helpers/test';
import { chatEntry, LARGE4_MODEL } from './helpers/chatEntry';
import { closeComposerMenu, openComposerTool, toolGroup } from './helpers/composerMenu';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// A searched turn can run past our time limit while the model is still working. A timeout from our own
// limit must not mark the model unavailable, and the notice offers Retry and another model. While the
// turn runs, the live line says what it is doing and counts the time.
//
// `generation_timeout` holds the turn until the route's real watchdog fires (shortened to 15s), so
// the notice is the production timeout path. `web_search_hangs` holds every web search until the web
// leg's own deadline. Both are preview-only fault headers.
//
// The chat starts on Large 4 picked by hand, never Auto: Auto routes around a model the tab marked
// busy and hides the notice, so a spec on Auto stays green with or without the fix.

async function setWebSearchAlways(page: Page, composer: Locator) {
	await composer.click({ timeout: 30_000 });
	await openComposerTool(page, 'Web search', { timeout: 15_000 });
	const always = toolGroup(page, 'Web search').getByRole('menuitemradio', { name: /^Always\b/ });
	await always.click();
	await expect(always, 'web search never moved to Always').toHaveAttribute('aria-checked', 'true');
	await closeComposerMenu(page);
}

async function expectElapsedCounting(reply: Locator) {
	const elapsed = reply.getByTestId('live-elapsed');
	const uncounted = 'the live line held without counting how long the turn had been running';
	await expect(elapsed, uncounted).toBeVisible({ timeout: 20_000 });
	await expect(elapsed, uncounted).toHaveText(/^· \d+s$/, { timeout: 20_000 });
	const first = Number((await elapsed.innerText()).match(/\d+/)?.[0]);
	await expect
		.poll(async () => Number((await elapsed.innerText()).match(/\d+/)?.[0]), {
			message:
				'the elapsed count on the live line stopped advancing while the turn was still working',
			timeout: 10_000
		})
		.toBeGreaterThanOrEqual(first + 2);
}

test(
	'a searched turn our time limit ends offers Retry and another model, and never calls the model unavailable',
	{ tag: ['@preview-only', '@F2', '@C3'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'generation_timeout');
		await page.goto(`/chat/models/${LARGE4_MODEL}`, { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await setWebSearchAlways(page, composer);
		await composer.fill('Plan a one-week trip to Barcelona on a 700 euro budget, day by day.');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expectElapsedCounting(reply);

		await expect(
			reply.getByText(/took too long to respond\. Please try again\./),
			'the forced timeout never surfaced: the watchdog did not fire, or the fault header did not reach the server'
		).toBeVisible({ timeout: 90_000 });
		await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
		const another = reply.getByRole('button', { name: 'Try another model' });
		await expect(
			another,
			'the timed-out turn offers only Retry, no way to another model'
		).toBeVisible();

		await expect(
			page.locator('[data-model-unavailable-notice]'),
			'the composer calls the picked model unavailable after our own time limit ended its turn'
		).toHaveCount(0);

		await another.click();
		await expect(
			page
				.locator('[role="menu"] [role="menuitemradio"], [data-model-sheet] [role="radio"]')
				.first(),
			'"Try another model" did not open the model picker'
		).toBeVisible({ timeout: 10_000 });
	}
);

test(
	'a long web search shows the turn is still searching and counts the time',
	{ tag: ['@preview-only', '@F2'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'web_search_hangs');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await setWebSearchAlways(page, composer);
		await composer.fill('What were the main news headlines about the European Union this week?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.locator('[data-live-line]'),
			'the live line never said the turn was searching while its web search hung'
		).toContainText(/Search/i, { timeout: 30_000 });
		await expectElapsedCounting(reply);

		await expect(turnDone(reply), 'the turn never ended after its search was cut').toBeVisible({
			timeout: 120_000
		});
		await expect(
			reply.getByText(/took too long to respond/),
			'a hung search ended the turn as a timeout'
		).toHaveCount(0);
	}
);
