// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { installFaultInjectionHeader, installModelReplay } from './helpers/faultInjection';
import { openComposerTool, toolGroup } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// When the web search for a turn doesn't finish, the answer is written without web sources (CUR-4091).
// Before this change it read like any other answer, and X-ray said Alpha had decided no search was
// needed. The two tests differ in one thing, the `web_search_hangs` fault, which holds every web search
// on the turn until the web leg's 15s deadline cuts it, on whichever harness the turn runs (the route's
// own search, or the native web_search tool). Web search is set to Always, so the turn always searches.
//
// @preview-only: the fault is a preview-only header.

const NOTE = 'Web search didn’t finish';

async function chatWithSearchAlways(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await openComposerTool(page, 'Web search', { timeout: 15_000 });
	// Same control and choice gap-card-language.spec.ts drives: Off, Auto, Always.
	const always = toolGroup(page, 'Web search').getByRole('menuitemradio', { name: /^Always\b/ });
	await always.click();
	await expect(always, 'web search never moved to Always').toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	return composer;
}

test(
	'a web search that does not finish puts a note on the answer, which stays after reload',
	{ tag: ['@preview-only', '@A5', '@CUR-4091'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installFaultInjectionHeader(page, 'web_search_hangs');
		const composer = await chatWithSearchAlways(page);

		await composer.fill('What were the main news headlines about the European Union this week?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
		await expect(
			answer.getByText(NOTE, { exact: true }),
			'the search was held past its deadline, yet the answer carries no note saying it did not finish'
		).toBeVisible();

		// The stored answer carries the note too, so it is not only a live-stream artefact.
		await page.reload();
		const stored = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(stored)).toBeVisible({ timeout: 30_000 });
		await expect(stored.getByText(NOTE, { exact: true })).toBeVisible();
	}
);

test(
	'a web search that finishes puts no unfinished-search note on the answer',
	{ tag: ['@preview-only', '@A5', '@CUR-4091'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installModelReplay(page);
		const composer = await chatWithSearchAlways(page);

		await composer.fill('What were the main news headlines about the European Union this week?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
		await expect(
			answer.getByText(NOTE, { exact: true }),
			'no fault was armed, yet the answer says its web search did not finish'
		).toHaveCount(0);
	}
);
