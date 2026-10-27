// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';
import { holdAnswerForStop } from './helpers/faultInjection';

// A stopped answer on a preview gained one more chunk of text a few seconds later, so Stop
// read as not having worked (CUR-2300). The contract: a stopped answer keeps exactly the text
// that was on screen when Stop was pressed, through the refresh that follows.
//
// Two moments can change the text after the click, and this reads it at both. The first is the next
// animation frame: in the default "smooth" streaming mode, tokens already received sit in a buffer
// that a scheduled frame flushes, and the stop point the server clamps to is measured before that
// flush. The second is the post-stop refresh, which reloads the conversation from the server a few
// seconds later; that is the slower of the two. The spec waits at least 5s after Stop and until
// the refresh's own requests have finished.
//
// An answer arrives in screened chunks of about 150 characters on preview, so 200 characters on
// screen means the stop lands mid-answer with more still to come. The prompt asks for far more than
// that. CUR-4027: a PR run's replayed answer arrives whole at once, so there the turn is held after
// its first sentence instead (holdAnswerForStop), and any text on screen is mid-answer. A held turn
// leaves nothing in the frame buffer, so the next-frame read bites on a live answer only.
const PROMPT =
	'CUR-2300: write a detailed 600-word essay on the history of river trade in medieval Europe.';

async function answerText(page: Page): Promise<string> {
	const answer = page.locator('[data-message-role="assistant"]').last();
	const blocks = await answer.locator('.prose').allInnerTexts();
	return blocks.join('\n').trim();
}

async function nextFrames(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

test(
	'a stopped answer keeps the text shown at Stop, through the next frame and the refresh after it',
	{ tag: '@CUR-2300' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const held = await holdAnswerForStop(page);
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(PROMPT);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = new URL(page.url()).pathname.split('/').pop() ?? '';

		const stop = page.getByRole('button', { name: 'Stop generating' });
		await expect(stop, 'the answer never started streaming').toBeVisible({ timeout: 30_000 });
		await expect
			.poll(() => answerText(page).then((t) => t.length), {
				message: held
					? 'the held answer never showed its first sentence'
					: 'the answer never reached 200 characters on screen',
				timeout: 60_000
			})
			.toBeGreaterThanOrEqual(held ? 1 : 200);

		// After Stop the page polls this conversation until the server has persisted the stopped turn,
		// then reloads it (waitForTerminalPersist, then invalidate). Every one of those is a GET that
		// names the conversation, so the refresh is over once they have started and gone quiet.
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
		const atStop = await answerText(page);

		await nextFrames(page);
		const afterFrame = await answerText(page);
		expect(
			afterFrame.length,
			`the answer grew in the frame after Stop (${atStop.length} → ${afterFrame.length} chars)`
		).toBeLessThanOrEqual(atStop.length);

		await expect
			.poll(() => reads > 0 && Date.now() - lastReadAt > 1_500 && Date.now() - stoppedAt > 5_000, {
				message: 'the page never reloaded the conversation after Stop',
				timeout: 20_000
			})
			.toBe(true);
		await nextFrames(page);
		const afterRefresh = await answerText(page);
		expect(
			afterRefresh.length,
			`the answer grew after the post-stop refresh (${atStop.length} → ${afterRefresh.length} chars)`
		).toBeLessThanOrEqual(atStop.length);
		expect(
			atStop.startsWith(afterRefresh.slice(0, Math.min(afterRefresh.length, 80))),
			'the refreshed answer is not the one that was on screen at Stop'
		).toBe(true);
	}
);
