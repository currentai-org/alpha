// e2e-product: @chat
// e2e-area: @turn
// Journey C2 (docs/journeys/c2-work-with-an-answer.md), row 4 refused: an edit over the
// message-length cap. The edit box used to close on Send, and the refused text reappeared in the main
// composer, where sending it made a new message instead of a new version of the edited one. Preview caps
// a message at 12,000 characters (USAGE_LIMITS.messageLength), so this is tagged @preview-only, like
// chat-message-send.spec.ts's composer twin.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import type { Page } from '@playwright/test';
import { installCannedReplies } from './helpers/faultInjection';

/** One short real turn, so there is a question to edit. Returns the main composer. */
async function answeredChat(page: Page) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await installCannedReplies(page);
	await composer.click({ timeout: 30_000 });
	await composer.fill('C2 journey: name one river in one word.');
	await composer.press('Enter');
	await expect(
		page
			.locator('[data-message-role="assistant"]')
			.last()
			.getByRole('button', { name: 'Copy to clipboard', exact: true }),
		'the first answer never finished, so there was nothing to edit'
	).toBeVisible({ timeout: 90_000 });
	return composer;
}

test(
	'an edit over the length cap keeps its edit box open with the text and says the message is too long',
	{ tag: ['@C2', '@preview-only', '@CUR-2825'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const composer = await answeredChat(page);

		const edited =
			`CUR-2825 check, deliberately over the length cap: ${'lorem ipsum '.repeat(1_050)}`.trim();
		expect(edited.length).toBeGreaterThan(12_000);
		const question = page.locator('[data-message-type="user"]').first();
		await journeyStep(page, 'C2', 4, async () => {
			await question.hover();
			await question.getByRole('button', { name: 'Edit', exact: true }).click();
			const editor = page.getByLabel('Edit your message');
			await editor.fill(edited);
			const bubble = page.locator('[data-editing-bubble]');
			await bubble.getByRole('button', { name: 'Send' }).click();

			await expect(
				bubble.getByText(/^Message too long:/),
				'the refused edit did not say why beside the edit box'
			).toBeVisible({ timeout: 30_000 });
			await expect(editor, 'the edit box closed on a refused edit').toBeVisible();
			expect(
				(await editor.inputValue()) === edited ? 'kept' : 'lost',
				'the edit box no longer holds the edited text'
			).toBe('kept');
			expect(
				(await composer.inputValue()).length,
				'the refused edit moved into the main composer, where Send makes a new message'
			).toBe(0);
			await holdForRecording(page);
		});
	}
);

// The server's refusal of an edit used to close the box and put the text in the main composer. The
// turn's POST is answered with a 429 in the browser, since reaching the real cap would take thousands
// of turns; the client's handling of that answer is what is under test. The body is the server's own
// shape for the daily cap, which names no wait. A per-minute refusal carries one since CUR-3410, and
// the box then shows the countdown in place of the reason (the test below).
test(
	"an edit the server refuses reopens its edit box with the text and the server's reason",
	{ tag: ['@C2', '@CUR-2825'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const composer = await answeredChat(page);
		const reason = "The service has reached today's request limit. Please try again later.";
		await page.route(/\/chat\/conversation\/[a-f0-9]+$/, (route) =>
			route.request().method() === 'POST'
				? route.fulfill({
						status: 429,
						contentType: 'application/json',
						body: JSON.stringify({ message: reason })
					})
				: route.continue()
		);

		const question = page.locator('[data-message-type="user"]').first();
		await question.hover();
		await question.getByRole('button', { name: 'Edit', exact: true }).click();
		const editor = page.getByLabel('Edit your message');
		await editor.fill('C2 journey: name one lake in one word.');
		await page.locator('[data-editing-bubble]').getByRole('button', { name: 'Send' }).click();

		const bubble = page.locator('[data-editing-bubble]');
		await expect(
			bubble.getByText(reason),
			'the refused edit did not reopen its box with the reason beside it'
		).toBeVisible({ timeout: 30_000 });
		await expect(editor, 'the reopened box lost the edited text').toHaveValue(
			'C2 journey: name one lake in one word.'
		);
		expect(
			(await composer.inputValue()).length,
			'the refused edit moved into the main composer, where Send makes a new message'
		).toBe(0);
		await holdForRecording(page);
	}
);

// Our own message limit says how long its window has left (CUR-3216), and the composer holds
// Send for that long. The edit box kept its Send live beside "wait a minute", so a press only met the
// same refusal and, being recorded, pushed the window further out.
test(
	'an edit refused by our message limit holds the edit box Send and counts the wait down (CUR-3410)',
	{ tag: ['@C2', '@CUR-3410'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await answeredChat(page);
		const reason = 'You are sending messages too fast. Please wait a minute and try again.';
		await page.route(/\/chat\/conversation\/[a-f0-9]+$/, (route) =>
			route.request().method() === 'POST'
				? route.fulfill({
						status: 429,
						contentType: 'application/json',
						body: JSON.stringify({ message: reason, retryAfterSeconds: 4 })
					})
				: route.continue()
		);

		const question = page.locator('[data-message-type="user"]').first();
		await question.hover();
		await question.getByRole('button', { name: 'Edit', exact: true }).click();
		await page.getByLabel('Edit your message').fill('C2 journey: name one lake in one word.');
		const bubble = page.locator('[data-editing-bubble]');
		const send = bubble.getByRole('button', { name: 'Send' });
		await send.click();

		await expect(
			bubble.getByText(/^You can send again in \d+ seconds?\.$/),
			'the refused edit gave no sign of when Send will work'
		).toBeVisible({ timeout: 30_000 });
		await expect(send, 'Send stayed live while the server said to wait').toBeDisabled();
		await holdForRecording(page);
		await expect(send, 'Send never came back once the wait was over').toBeEnabled({
			timeout: 15_000
		});
	}
);

// CUR-3410, the server half (the 429 carries the wait into the stream) is a route test now:
// server.prestream.spec.ts, "a message-limit refusal streams Status=Error 429 …" (SOL-195).
