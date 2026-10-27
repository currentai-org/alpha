// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';

// A reader scrolled down to keep reading a long answer while it was still being written, and
// every new chunk pulled the view back up to the top of the answer (CUR-2526). ChatWindow.svelte re-pins the
// newest question to the top of the view on each resize while a turn streams, which is the right
// thing until the reader takes over the scroll themselves.
//
// The contract, in order:
// 1. Left alone, the view follows the turn: the question stays pinned near the top while the answer
//    grows below it.
// 2. Once the reader scrolls down with the wheel, later chunks never move the view back up.
//
// Answers arrive in screened chunks of about 150 characters on preview, so the prompt asks for far
// more text than one screen holds. The check in step 2 only means something if the answer kept
// growing after the scroll, so that is asserted too.
//
// `@no-replay`: a replayed answer streams with no pacing, so a 10,000-character answer finished about
// 5 s after send and ended before the scroll could see it grow (SOL-166). The check needs live pacing.
const PROMPT =
	'CUR-2526: write a detailed 900-word essay on the history of river trade in medieval Europe.';
const PIN_TOLERANCE_PX = 120;
const WHEEL_PX = 250;

interface ScrollState {
	scrollTop: number;
	room: number;
	questionTop: number;
	answerChars: number;
	streaming: boolean;
}

async function scrollState(page: Page): Promise<ScrollState> {
	return page.evaluate(() => {
		const scroller = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement;
		const questions = scroller.querySelectorAll('[data-message-type="user"]');
		const question = questions[questions.length - 1] as HTMLElement;
		const answers = scroller.querySelectorAll('[data-message-role="assistant"]');
		const answer = answers[answers.length - 1] as HTMLElement | undefined;
		return {
			scrollTop: scroller.scrollTop,
			room: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
			questionTop: question.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
			answerChars: answer?.innerText.length ?? 0,
			streaming: !!document.querySelector('button[aria-label="Stop generating"]')
		};
	});
}

test(
	'the view follows a streaming answer until the reader scrolls, then never pulls them back up',
	{ tag: ['@CUR-2526', '@no-replay'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(PROMPT);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const stop = page.getByRole('button', { name: 'Stop generating' });
		await expect(stop, 'the answer never started streaming').toBeVisible({ timeout: 30_000 });

		// Step 1: wait for the answer to overflow the view, watching the question stay pinned while
		// it grows. Two growth steps seen pinned is the "follows" half of the contract.
		let pinnedGrowths = 0;
		let lastChars = 0;
		const overflowDeadline = Date.now() + 90_000;
		for (;;) {
			const s = await scrollState(page);
			expect(s.streaming, 'the answer finished before it overflowed the view').toBe(true);
			if (s.answerChars > lastChars && lastChars > 0) {
				// ChatWindow re-pins from a ResizeObserver, so a sample taken between a chunk's layout and
				// that callback can catch the view one frame off the pin: a run read -9px once,
				// on both attempts. A reader never sees one
				// frame. CUR-2526's defect held the view off the pin for the rest of the turn, so an
				// off-pin sample fails only if the view is still off the pin 1 s later.
				const pinned = (top: number) => top >= -2 && top <= PIN_TOLERANCE_PX;
				if (!pinned(s.questionTop)) {
					test.info().annotations.push({
						type: 'pin-excursion',
						description: `${Math.round(s.questionTop)}px from the top of the view at ${s.answerChars} chars`
					});
					await expect
						.poll(async () => pinned((await scrollState(page)).questionTop), {
							message: `the question stayed off its pin near the top of the view while the answer streamed, before the reader scrolled (first seen at ${Math.round(s.questionTop)}px)`,
							timeout: 1_000,
							intervals: [100]
						})
						.toBe(true);
				}
				pinnedGrowths += 1;
			}
			lastChars = s.answerChars;
			if (pinnedGrowths >= 2 && s.room > WHEEL_PX + 150) break;
			expect(Date.now(), 'the answer never overflowed the view while streaming').toBeLessThan(
				overflowDeadline
			);
			await page.waitForTimeout(100);
		}

		// Step 2: the reader scrolls down with the wheel. From here on, scrollTop must never drop.
		const box = await page.getByTestId('chat-scroll').boundingBox();
		if (!box) throw new Error('the chat scroll container has no box');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		const before = await scrollState(page);
		await page.mouse.wheel(0, WHEEL_PX);
		await expect
			.poll(async () => (await scrollState(page)).scrollTop, {
				message: 'the wheel did not scroll the conversation'
			})
			.toBeGreaterThan(before.scrollTop + WHEEL_PX / 2);
		const scrolled = await scrollState(page);

		let lowest = scrolled.scrollTop;
		let growthsAfterScroll = 0;
		let chars = scrolled.answerChars;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && growthsAfterScroll < 4) {
			const s = await scrollState(page);
			// The spacer under the answer collapses when the turn ends, which can clamp scrollTop
			// legitimately, so only streaming samples count.
			if (!s.streaming) break;
			lowest = Math.min(lowest, s.scrollTop);
			if (s.answerChars > chars) growthsAfterScroll += 1;
			chars = s.answerChars;
			await page.waitForTimeout(100);
		}

		expect(
			growthsAfterScroll,
			'the answer stopped growing right after the scroll, so this run cannot show whether a chunk pulls the view back'
		).toBeGreaterThanOrEqual(1);
		expect(
			lowest,
			`a streamed chunk pulled the view back up from ${Math.round(scrolled.scrollTop)}px to ${Math.round(lowest)}px after the reader scrolled down`
		).toBeGreaterThanOrEqual(scrolled.scrollTop - 2);
	}
);
