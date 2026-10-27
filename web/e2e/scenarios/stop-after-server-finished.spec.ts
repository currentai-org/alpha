// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';

// In the default "smooth" streaming mode the page reveals received text at a steady pace,
// so Stop is still on screen for a moment after the server has finished and stored the whole answer (CUR-2306).
// A stop in that moment has no generation left to abort, and the reload after it brought back the
// whole answer, including the part that had not been revealed yet.
//
// The contract: Stop keeps the text that was on screen when it was pressed, even when the server had
// already finished. The window is a few hundred milliseconds in real time, so the spec holds it open
// with the page's clock. Once some of the answer is on screen it pauses the page's timers, which
// freezes smooth mode's reveal but not the network read, waits in real time until the server has
// stored the finished answer, and only then presses Stop.
const PROMPT = 'CUR-2306: in about 120 words, explain why rivers meander.';

async function answerText(page: Page): Promise<string> {
	const answer = page.locator('[data-message-role="assistant"]').last();
	const blocks = await answer.locator('.prose').allInnerTexts();
	return blocks.join('\n').trim();
}

// The stored final answer's length once the server has finished the turn, or null while it has not.
async function storedFinalAnswerLength(page: Page, conversationId: string): Promise<number | null> {
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	if (!res.ok()) return null;
	const conv = (await res.json()) as {
		json?: { messages?: { from: string; updates?: { type: string; text?: string }[] }[] };
	};
	const last = (conv.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
	const final = last?.updates?.find((u) => u.type === 'finalAnswer');
	return typeof final?.text === 'string' ? final.text.length : null;
}

test(
	'Stop pressed after the server finished but before the page revealed it all keeps what was shown',
	{ tag: '@CUR-2306' },
	async ({ page }) => {
		await page.clock.install();
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(PROMPT);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = new URL(page.url()).pathname.split('/').pop() ?? '';

		const stop = page.getByRole('button', { name: 'Stop generating' });
		await expect(stop, 'the answer never started streaming').toBeVisible({ timeout: 30_000 });

		// Freeze the reveal as soon as the turn starts, before any text, then let the server finish and
		// store the answer in real time. The test's own requests are not on the page's clock. Pausing
		// only after text showed (CUR-3345) let the page clock run while the poll waited, and when the
		// whole answer arrived in one piece smooth mode could reveal all of it and take Stop away first.
		// The pause target comes from the page's own clock: the test process's Date.now() can sit behind
		// it, and pausing at a past time throws. A slow round trip on a busy runner can also outlast a
		// small margin, so a past target is retried from a fresh reading with a wider
		// margin, never a fixed one big enough to let text show first.
		for (let margin = 50; ; margin *= 2) {
			const pageNow = await page.evaluate(() => Date.now());
			try {
				await page.clock.pauseAt(pageNow + margin);
				break;
			} catch (error) {
				if (margin >= 800 || !/fast-forward to the past/.test(String(error))) throw error;
			}
		}
		let fullLength = 0;
		await expect
			.poll(
				async () => {
					fullLength = (await storedFinalAnswerLength(page, conversationId)) ?? 0;
					return fullLength;
				},
				{ message: 'the server never stored a finished answer', timeout: 60_000 }
			)
			.toBeGreaterThan(0);

		// Smooth mode paces its reveal with setTimeout, so stepping the paused clock reveals a few words at
		// a time; stop at the first text on screen.
		await expect
			.poll(
				async () => {
					await page.clock.runFor(40);
					return (await answerText(page)).length;
				},
				{ message: 'no part of the answer ever reached the screen', timeout: 60_000 }
			)
			.toBeGreaterThan(0);

		await expect(stop, 'Stop left the screen while the reveal was frozen').toBeVisible();
		const atStop = await answerText(page);
		expect(
			atStop.length,
			`the reveal had already shown the whole answer (${atStop.length} of ${fullLength} chars), so the case was not exercised`
		).toBeLessThan(fullLength);

		let reads = 0;
		let lastReadAt = 0;
		page.on('response', (res) => {
			if (
				res.request().method() === 'GET' &&
				res.url().includes(conversationId) &&
				!res.url().includes('/stop-generating')
			) {
				reads += 1;
				lastReadAt = Date.now();
			}
		});
		await stop.click();
		const stoppedAt = Date.now();
		await page.clock.resume();

		await expect
			.poll(() => reads > 0 && Date.now() - lastReadAt > 1_500 && Date.now() - stoppedAt > 5_000, {
				message: 'the page never reloaded the conversation after Stop',
				timeout: 30_000
			})
			.toBe(true);
		const afterRefresh = await answerText(page);
		expect(
			afterRefresh.length,
			`the answer grew after the post-stop refresh (${atStop.length} → ${afterRefresh.length} of ${fullLength} chars)`
		).toBeLessThanOrEqual(atStop.length);
	}
);
