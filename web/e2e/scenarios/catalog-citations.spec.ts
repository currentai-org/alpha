// e2e-product: @chat @site
// e2e-area: @provenance @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { openAnswerSources } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

// A catalog product whose description runs long is several retrieved chunks sharing one
// url. The model gets every chunk, each under its own source number, and the page shows them as one
// entry: X-ray's Step by step lists the product once, its entries are numbered 1..k with no
// gap, and the answer's [n] markers are rewritten to those numbers, so no marker repeats back to back
// and none points past the list. Before the fix this question listed /product/openguardrails
// three times.

async function openChat(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

const PRODUCT = '/product/openguardrails';

test(
	'a catalog product retrieved as several chunks is cited as one entry, numbered without gaps',
	{ tag: '@CUR-888' },
	async ({ page }) => {
		test.setTimeout(120_000);
		await openChat(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('What does OpenGuardrails do?');
		await composer.press('Enter');

		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const convId = new URL(page.url()).pathname.split('/').at(-1)!;
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'no finished answer' + warmupContext()
		).toBeVisible({ timeout: 60_000 });

		// The collapse is only exercised when the model really got more than one chunk of the page. With
		// one, every assertion below passes without the fix, so fail on that rather than pass on it.
		// The v2 route returns the stored message whole; the older one drops `rag`.
		const res = await page.request.get(`/chat/api/v2/conversations/${convId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		const conv = (await res.json()) as {
			json?: { messages?: { from: string; rag?: { sources?: { url?: string }[] } }[] };
		};
		const stored =
			(conv.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)?.rag?.sources ?? [];
		expect(
			stored.filter((s) => s.url === PRODUCT).length,
			`the turn retrieved fewer than two chunks of ${PRODUCT}, so nothing here was collapsed; sources: ${JSON.stringify(stored.map((s) => s.url))}`
		).toBeGreaterThanOrEqual(2);

		await openAnswerSources(page, answer, {
			disclosure: { timeout: 15_000 },
			tab: { timeout: 10_000 },
			sources: { timeout: 10_000 }
		});
		// The source rows under X-ray's Step by step, one per displayed entry.
		const strip = page.locator('[data-xray-steps]');
		const rows = strip.locator('[data-step-source]');
		await expect(rows.first()).toBeVisible();

		await expect(
			strip.locator(`a[href="${PRODUCT}"]`),
			'Step by step lists the product more than once'
		).toHaveCount(1);

		// RAG entries are numbered first, so the listed numbers must be exactly 1..k.
		const numbers = (await rows.allInnerTexts())
			.map((t) => Number(t.match(/^\s*\[(\d+)\]/)?.[1]))
			.sort((a, b) => a - b);
		expect(numbers, 'Step by step numbers its entries with a gap').toEqual(
			numbers.map((_, i) => i + 1)
		);

		// Inline markers: the [n] anchors in the answer, in reading order.
		const inline = (await answer.locator('a').allInnerTexts())
			.map((t) => t.match(/^\[(\d+)\]$/)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number);
		expect(
			await answer.innerHTML(),
			`the answer renders one marker twice in a row: ${inline.join(',')}`
		).not.toMatch(/\[(\d+)\]<\/a><a[^>]*>\[\1\]<\/a>/);
		// A marker that pointed at any of the product's chunks now shows the product's entry number.
		const productRow = await rows.filter({ has: page.locator(`a[href="${PRODUCT}"]`) }).innerText();
		const productN = productRow.match(/^\s*\[(\d+)\]/)?.[1];
		for (const text of await answer.locator(`a[href="${PRODUCT}"]`).allInnerTexts()) {
			if (!/^\[\d+\]$/.test(text)) continue;
			expect(text, `a marker for ${PRODUCT} does not match its listed entry [${productN}]`).toBe(
				`[${productN}]`
			);
		}
	}
);
