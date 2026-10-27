// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry, CONVERSATION_URL } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// The chat tells readers that the numbers in a searched answer, like [1], point to the pages
// it found so they can check them (CUR-3231). `native-web-search.spec.ts` asserts that on the native harness only,
// forced through the fuzz_override cookie that production refuses. This walk forces nothing: it asks
// a news question as a guest on whatever harness the deployment serves, so the same test runs on a PR
// preview and in the live suite's production leg.
//
// It reads the stored grounding, asserts at least one [n] marker in the answer links to a page the
// turn retrieved, then clicks one and checks the page that opens is that source.
//
// ONE CHAT TURN, AND IT CLEANS UP AFTER ITSELF. On www the conversation is deleted at the end, as
// production-promises.spec.ts does, so the live suite leaves nothing behind every four hours.
// `?ph_test=live-suite` marks the browser events as internal traffic, as there.

type Stored = {
	id: string;
	webSearch?: { query: string; sources: { n: number; url: string }[] };
	searchAttempt?: { searched: boolean };
};

test(
	'a searched news answer numbers its sources, each [n] a link to a page the turn retrieved, and clicking one opens it',
	{ tag: ['@A5', '@live', '@CUR-3231'] },
	async ({ page, context }) => {
		test.setTimeout(180_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(`${chatEntry()}?ph_test=live-suite`, { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		const message = page.locator('[data-message-role="assistant"]').last();

		let conversationId = '';
		try {
			let urls = new Set<string>();
			let cited: string[] = [];
			await journeyStep(page, 'A5', 17, async () => {
				await composer.click({ timeout: 30_000 });
				await composer.fill("What's the latest news on the EU AI Act this week?");
				await composer.press('Enter');
				await page.waitForURL(CONVERSATION_URL, { timeout: 30_000 });
				conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
				await expect(
					turnDone(message),
					'the news question never finished within 120s' + warmupContext()
				).toBeVisible({ timeout: 120_000 });

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
				urls = new Set((stored?.webSearch?.sources ?? []).map((s) => s.url));
				expect(
					urls.size,
					`a news question stored no web sources (searchAttempt ${JSON.stringify(stored?.searchAttempt)}), so the turn never searched or the search grounded nothing`
				).toBeGreaterThan(0);

				cited = (
					await message
						.locator('a[href^="http"]')
						.evaluateAll((links) =>
							links
								.filter((a) => /^\[\d+\]$/.test((a.textContent ?? '').trim()))
								.map((a) => a.getAttribute('href') ?? '')
						)
				).filter((href) => urls.has(href));
				expect(
					cited,
					`the answer shows no [n] marker linking to a page the turn retrieved (retrieved: ${JSON.stringify([...urls])})`
				).not.toHaveLength(0);

				// The marker is what a reader clicks, so click it and read what the new tab asks for. Its first
				// navigation is the comparison, since a news site may then redirect to a consent page.
				const href = cited[0];
				const popupOpened = context.waitForEvent('page', { timeout: 15_000 });
				const navigated = context.waitForEvent('request', {
					predicate: (r) => r.isNavigationRequest() && r.url().startsWith('http'),
					timeout: 15_000
				});
				await message.locator(`a[href="${href}"]`).first().click();
				const popup = await popupOpened;
				const opened = (await navigated).url();
				expect(opened, `clicking the [n] marker for ${href} opened ${opened}`).toBe(
					new URL(href).href
				);
				await popup.close();
			});
		} finally {
			if (conversationId) {
				const origin = new URL(page.url()).origin;
				await page.request.delete(`${origin}/chat/api/v2/conversations/${conversationId}`, {
					headers: { origin }
				});
			}
		}
	}
);
