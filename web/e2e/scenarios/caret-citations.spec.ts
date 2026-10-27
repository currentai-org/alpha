// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// Mistral Large 3 cites web sources in Pandoc's caret shapes, "Tokyo^1,2^" and "[^1^]", and the
// answer showed them as raw carets where a numbered link to the source belonged (A2 recordings 8 to 10).
// It also writes a range, "Tokyo[1]-4.", which linked [1] and printed "-4". CUR-2393: bold round the
// markers alone, "problemas**[1][2]**.", printed both pairs of asterisks. Escaped brackets, "Qatar \[1,3,4\].",
// opened a display-math block that showed "1,3,4" on a monospace line of its own (A5 recordings 2 and 4).
// Large 3 writes carets in only some answers, so the `caret_cited_reply` fault streams one with no model
// call: three Wikipedia sources, then an answer citing the second and third every way, split mid-marker as
// a stream splits. CUR-3933: search put an uncited page first and the answer's citations started at [3], so
// the page must number the cited sources from [1] in the order the answer cites them.
const SOURCES = {
	'1': 'https://en.wikipedia.org/wiki/Tokyo',
	'2': 'https://en.wikipedia.org/wiki/Canberra'
};

test(
	'a caret-cited, range-cited, bold-wrapped or bracket-escaped answer shows each citation as a link to its source numbered from [1], with no caret, dash, asterisks or math block',
	{ tag: ['@preview-only', '@CUR-3551', '@CUR-2393', '@CUR-3933'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'caret_cited_reply');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`What are the capitals of Japan and Australia? ${Date.now()}`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByRole('button', { name: 'Retry' }),
			'the turn never finished'
		).toBeVisible({
			timeout: 90_000
		});

		// The stored answer still holds the carets, so the fault sent them and any pass below is the
		// renderer's work.
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: { messages?: Array<{ from: string; content?: string }> };
		};
		const stored = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(
			stored?.content,
			'the fault never reached the server: no caret citation stored'
		).toContain('Tokyo^2,3^');
		expect(stored?.content, 'the fault sent no citation range').toContain('capitals[2]-3.');
		expect(stored?.content, 'the fault sent no bold-wrapped citations').toContain(
			'cities**[2][3]**.'
		);
		expect(stored?.content, 'the fault sent no escaped-bracket citations').toContain(
			'Olympics \\[2,3\\].'
		);

		await expect(reply).toContainText('The capital of Japan is Tokyo');
		const answerText = (await reply.locator('.prose').allInnerTexts()).join('\n');
		expect(answerText, 'a caret reached the page as text').not.toContain('^');
		expect(answerText, 'a citation range printed its dash ("[1]-2")').not.toMatch(/\]\s*[-–]\s*\d/);
		expect(answerText, 'bold round the citations printed its asterisks').not.toContain('*');
		await expect(reply).toContainText('live in cities');
		await expect(reply).toContainText('hosted the Olympics');
		await expect(
			reply.locator('.katex, [data-katex-pending]'),
			'escaped citation brackets opened a math block'
		).toHaveCount(0);

		const cited = await reply
			.locator('a[href^="http"]')
			.evaluateAll((links) =>
				links
					.map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '' }))
					.filter((l) => /^\[?\d+\]?$/.test(l.text))
			);
		for (const [n, url] of Object.entries(SOURCES)) {
			expect(
				cited.some((l) => l.text.replace(/[[\]]/g, '') === n && l.href === url),
				`citation ${n} does not link to ${url} (links: ${JSON.stringify(cited)})`
			).toBe(true);
		}
		expect(
			cited[0]?.text.replace(/[[\]]/g, ''),
			`the first citation is not numbered [1] (links: ${JSON.stringify(cited)})`
		).toBe('1');
		expect(
			cited.some((l) => l.href.endsWith('/Sydney')),
			'the uncited source got a citation link'
		).toBe(false);
	}
);
