// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// On the native harness Mistral Large 3 decides to search by calling `web_search` itself,
// and the call runs through our own search (search/runSearch.ts), so the answer is grounded and cited
// the same way the scaffolded gate's answers are. This drives one such turn the way a visitor does and
// reads the stored grounding and the citations on screen: the turn must store web sources, and at
// least one numbered marker in the answer must link to a URL among them. A marker pointing nowhere, or
// at a page the turn never retrieved, is what the provenance promise rules out (CUR-2275).

type Stored = {
	id: string;
	webSearch?: { query: string; sources: { n: number; url: string }[] };
	searchAttempt?: { searched: boolean };
};

test(
	'on the native harness, a news question searches through our grounding and cites what it found',
	{ tag: ['@preview-only', '@CUR-2275'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill("What's the latest news on the EU AI Act this week?");
		await composer.press('Enter');

		const message = page.locator('[data-message-role="assistant"]').first();
		await expect(
			turnDone(message),
			'the news question never finished within 90s' + warmupContext()
		).toBeVisible({ timeout: 90_000 });
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as { json?: { messages?: Stored[] } };
		const id = await message.getAttribute('data-message-id');
		const stored = body.json?.messages?.find((m) => m.id === id);
		test.info().annotations.push({
			type: 'search',
			description: JSON.stringify({
				query: stored?.webSearch?.query,
				sources: stored?.webSearch?.sources.length,
				attempt: stored?.searchAttempt
			})
		});

		const urls = new Set((stored?.webSearch?.sources ?? []).map((s) => s.url));
		expect(
			urls.size,
			`a news question stored no web sources (searchAttempt ${JSON.stringify(stored?.searchAttempt)}), so the model never searched or the search grounded nothing`
		).toBeGreaterThan(0);

		const cited = await message
			.locator('a[href^="http"]')
			.evaluateAll((links) =>
				links
					.filter((a) => /^\[?\d+\]?$/.test((a.textContent ?? '').trim()))
					.map((a) => a.getAttribute('href') ?? '')
			);
		expect(
			cited.filter((href) => urls.has(href)),
			`the answer shows no numbered citation linking to a source the turn retrieved (markers: ${JSON.stringify(cited)})`
		).not.toHaveLength(0);
	}
);
