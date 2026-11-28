// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// A searched turn can hold the live line for over a minute, and "Searching the web…" with a
// seconds count read the same whether the search was moving or hung. Each search now shows as a numbered
// row, running and then how many sources it brought, never its query. The rows go once the answer starts.
//
// A row with its count can show for under a second before the answer starts, which a poll can miss, so the
// page records every row text it shows and the assertions read that record.
//
// The prompt is searched-answer-citations.spec.ts's news topic, which retrieves sources on previews.

const PROMPT = "What's the latest news on the EU AI Act this week?";

test('while a searched answer is coming, each search shows by number and then how many sources it brought, never its query', async ({
	page
}) => {
	test.setTimeout(180_000);
	await page.addInitScript(() => {
		try {
			localStorage.setItem('ap:webSearchChoice', 'always');
			localStorage.setItem('ap:webSearchMode', 'always');
		} catch {
			// Storage blocked: the row assertion below fails and says so.
		}
		const seen: string[] = [];
		(window as unknown as { __searchRows: string[] }).__searchRows = seen;
		new MutationObserver(() => {
			for (const row of document.querySelectorAll('[data-testid="live-search-row"]')) {
				const text = row.textContent ?? '';
				if (!seen.includes(text)) seen.push(text);
			}
		}).observe(document, { subtree: true, childList: true, characterData: true });
	});
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(`${chatEntry()}?ph_test=live-suite`, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(PROMPT);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	try {
		const message = page.locator('[data-message-role="assistant"]').last();
		await expect(
			message.getByTestId('live-search-row').first(),
			'no search row showed while the searched turn was running' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await expect(
			turnDone(message),
			'the turn never finished within 120s' + warmupContext()
		).toBeVisible({ timeout: 120_000 });
		const seen = await page.evaluate(
			() => (window as unknown as { __searchRows: string[] }).__searchRows
		);
		expect(seen, 'no row showed a search running').toContainEqual(
			expect.stringMatching(/^Web search \d+…$/)
		);
		expect(seen, 'no row said what a search brought back').toContainEqual(
			expect.stringMatching(/^Web search \d+ · (\d+ sources?|didn't finish)$/)
		);
		expect(seen.join(' '), 'a row showed the words of the query').not.toMatch(/AI Act/i);
		await expect(
			message.getByTestId('live-search-row'),
			'the rows stayed up after the answer arrived'
		).toHaveCount(0);
	} finally {
		if (id) {
			const origin = new URL(page.url()).origin;
			await page.request.delete(`${origin}/chat/api/v2/conversations/${id}`, {
				headers: { origin }
			});
		}
	}
});
