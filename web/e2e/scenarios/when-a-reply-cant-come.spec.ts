// e2e-product: @chat
// e2e-area: @turn
// CUR-2628 — journey C3 (docs/journeys/c3-when-a-reply-cant-come.md): when a reply can't come, the
// visitor is told which failure it was, in words, with a way to try again. Steps 1-3 (too long, busy,
// too slow) are walked by specs that already existed and now carry @C3; this file walks the two that
// had no visitor-side check: an answer cut off partway, and a send the server fails outright.
// Preview-only: the fault switch is never armed on production (faultInjection.ts).
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader, type FaultInjectionName } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';

async function sendUnderFault(page: Page, fault: FaultInjectionName, question: string) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await installFaultInjectionHeader(page, fault);
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(question);
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
}

test(
	'an answer whose lane drops partway says the connection dropped and offers Retry, not raw "terminated"',
	{ tag: ['@C3', '@CUR-2628', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await journeyStep(page, 'C3', 4, async () => {
			await sendUnderFault(
				page,
				'stream_truncates_midway',
				`C3 journey ${Date.now()}: describe how a river delta forms, in a few paragraphs.`
			);
			const reply = page.locator('[data-message-role="assistant"]').last();
			const notice = reply.getByRole('alert');
			await expect(
				notice,
				'the cut-off answer ends with no notice; if it answered in full, the fault never reached the server'
			).toBeVisible({ timeout: 90_000 });
			// Before CUR-2628 this notice read undici's own text, "terminated".
			await expect(notice).toContainText(
				/The connection to .+ dropped before this answer finished/
			);
			await expect(notice).not.toContainText('terminated');
			await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
		});
	}
);

test(
	'a send the server fails outright says the connection dropped and keeps the question',
	{ tag: ['@C3', '@CUR-2628', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await journeyStep(page, 'C3', 5, async () => {
			const question = `C3 journey ${Date.now()}: what is the tallest mountain in Wales?`;
			await sendUnderFault(page, 'chat_500', question);
			// Said in the turn itself, with Retry, rather than only in a toast that fades (CUR-2613).
			const notice = page.locator('[data-message-role="assistant"]').last().getByRole('alert');
			await expect(notice, 'a send answered 500 does not tell the visitor it failed').toContainText(
				'The connection dropped before a reply arrived. Please try again.',
				{ timeout: 90_000 }
			);
			await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
			await expect(page.locator('[data-message-type="user"]').last()).toContainText(question);
			await expect(page.getByText('Internal Error')).toHaveCount(0);
			// Once the visitor is told the send failed, the turn has to stop behaving as though it
			// were still running (CUR-2613). Before the fix, "Working on it…" kept counting and Stop stayed live.
			await expect(
				page.getByRole('button', { name: 'Stop generating' }),
				'Stop is still offered after the send was reported as failed'
			).toHaveCount(0, { timeout: 20_000 });
			await expect(
				page.getByText('Working on it…'),
				'the turn still reads "Working on it…" after the send was reported as failed'
			).toHaveCount(0);
		});
	}
);

test(
	'a model error no named copy covers says the model could not answer, with no status code or SDK text',
	{ tag: ['@C3', '@CUR-2829', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await journeyStep(page, 'C3', 7, async () => {
			await sendUnderFault(
				page,
				'lane_server_error',
				`C3 journey ${Date.now()}: what is the longest river in Portugal?`
			);
			const notice = page.locator('[data-message-role="assistant"]').last().getByRole('alert');
			await expect(
				notice,
				'the failed turn shows no notice; if it answered, the fault never reached the server'
			).toBeVisible({ timeout: 90_000 });
			// Before CUR-2829 this notice was the SDK's own text, "500 Internal Server Error".
			await expect(notice).toContainText(/couldn't answer this time/);
			await expect(notice).not.toContainText('500');
			await expect(notice).not.toContainText('Internal Server Error');
			await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
		});
	}
);

// Our own per-session limit (CUR-2804). The fault lowers it to one send per 30s window, so the second
// question, sent once the first answer is in, lands inside the window and is refused.
// The refusal used to say only "Try again later", the toast faded, and Send stayed live, so the
// wait looked like a frozen screen and an early press (which counts too) pushed it further out (CUR-3216).
// A grader read the held Send as ready, so the spec also checks it is drawn dimmed, not only disabled (CUR-3800).
test(
	'a send past our own message limit says so, keeps the typed text, counts down with Send held and dimmed, and goes through once the window passes (CUR-3800)',
	{ tag: ['@C3', '@CUR-2804', '@CUR-3216', '@CUR-3800', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await journeyStep(page, 'C3', 8, async () => {
			const firstSentAt = Date.now();
			await sendUnderFault(
				page,
				'session_rate_limit_low',
				`C3 journey ${firstSentAt}: reply with exactly one word: hello.`
			);
			const assistant = page.locator('[data-message-role="assistant"]');
			await expect(assistant.last()).toContainText(/\S/, { timeout: 60_000 });
			await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
				timeout: 60_000
			});
			expect(
				Date.now() - firstSentAt,
				'the first answer took longer than the 30s window, so the second send cannot test the limit'
			).toBeLessThan(28_000);

			const second = `C3 journey ${Date.now()}: and what is the capital of Norway?`;
			const composer = page.getByLabel('Message AI Potluck');
			await composer.fill(second);
			await composer.press('Enter');
			const refusedAt = Date.now();
			await expect(
				page.getByText('You are sending too many messages. Try again later.'),
				'a send past the limit was not refused with the rate-limit copy; if it answered, the fault never reached the server'
			).toBeVisible({ timeout: 30_000 });
			await expect(composer, 'the refused question should be back in the composer').toHaveValue(
				second
			);
			await expect(page.locator('[data-message-type="user"]')).toHaveCount(1, { timeout: 15_000 });

			// The refusal recorded an event too, so the window runs from it: about 30s from the refusal.
			const countdown = page.getByText(/^You can send again in \d+ seconds?\.$/);
			await expect(countdown, 'the refusal shows no wait').toBeVisible({ timeout: 10_000 });
			const shown = Number((await countdown.textContent())?.match(/\d+/)?.[0]);
			expect(shown, 'the wait shown is not the window left').toBeGreaterThan(15);
			expect(shown).toBeLessThanOrEqual(31);
			const send = page.getByRole('button', { name: 'Send message' });
			await expect(send, 'Send stays live while the wait runs').toBeDisabled();
			await expect(send, 'Send is disabled but still drawn as ready while the wait runs').toHaveCSS(
				'opacity',
				'0.4'
			);
			await expect(countdown, 'the countdown did not count down').not.toHaveText(
				`You can send again in ${shown} seconds.`,
				{ timeout: 5_000 }
			);

			await expect(countdown, 'the countdown never ended').toBeHidden({ timeout: 45_000 });
			expect(Date.now() - refusedAt, 'the hold ended before the window could have').toBeGreaterThan(
				shown * 1_000 - 2_000
			);
			await expect(composer).toHaveValue(second);
			await expect(send).toBeEnabled();
			await expect(send, 'Send still looks held after the wait ended').toHaveCSS('opacity', '1');
			await send.click();
			await expect(page.locator('[data-message-type="user"]').last()).toContainText(second, {
				timeout: 30_000
			});
			await expect(assistant).toHaveCount(2, { timeout: 60_000 });
			await expect(assistant.last()).toContainText(/Oslo/i, { timeout: 60_000 });
			await expect(assistant.last().getByRole('alert')).toHaveCount(0);
		});
	}
);
