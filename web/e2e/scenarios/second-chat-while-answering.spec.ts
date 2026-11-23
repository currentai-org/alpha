// e2e-product: @chat
// e2e-area: @composer @turn
// a turn still answering in one chat must not lock any other chat's composer. The busy state
// was one page-wide flag, so New chat opened with Stop where Send should be and nothing could be sent
// until the first answer finished, two minutes for an agent turn. `answer_streams_slowly` keeps the
// first answer growing for about sixteen seconds, so it is certainly still running when the visitor
// opens the new chat and sends there.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

const FIRST_SENTENCE = /grinding the rock beneath them/;
const LAST_SENTENCE = /deep U-shaped valley remains/;
const CONVERSATION = /\/conversation\/([a-f0-9]+)/;

test(
	'a new chat opened while another chat is still answering takes a message, and both chats get their answer',
	{ tag: ['@C3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await startChattingPastWelcome(welcome);
		});
		await installFaultInjectionHeader(page, 'answer_streams_slowly');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		const stop = page.getByRole('button', { name: 'Stop generating' });
		const reply = page.locator('[data-message-role="assistant"]').last();

		await composer.click({ timeout: 30_000 });
		await composer.fill('How do glaciers carve valleys?');
		await composer.press('Enter');
		await page.waitForURL(CONVERSATION, { timeout: 30_000 });
		const firstId = CONVERSATION.exec(page.url())![1];
		await expect(reply, 'the first answer never started streaming').toContainText(FIRST_SENTENCE, {
			timeout: 90_000
		});
		await expect(
			stop,
			'the first answer finished before New chat, so nothing was still running to lock the new chat'
		).toBeVisible();
		await expect(reply).not.toContainText(LAST_SENTENCE);

		await page.getByRole('link', { name: /^New chat/ }).click();
		await expect(page, 'New chat never left the first conversation').not.toHaveURL(
			/\/conversation\//,
			{ timeout: 30_000 }
		);
		await expect(
			stop,
			"the new chat's composer shows Stop for the other chat's turn, so it cannot send"
		).toHaveCount(0);

		await composer.click({ timeout: 30_000 });
		await composer.fill('And how do rivers carve canyons?');
		await composer.press('Enter');
		await expect(
			page,
			'the message sent in the new chat never became its own conversation'
		).toHaveURL(new RegExp(`/conversation/(?!${firstId})[a-f0-9]+`), { timeout: 30_000 });
		await expect(page.locator('[data-message-type="user"]')).toHaveCount(1);
		await expect(reply, 'the second chat never got its whole answer').toContainText(LAST_SENTENCE, {
			timeout: 90_000
		});
		await expect(stop).toHaveCount(0, { timeout: 30_000 });

		// The first chat kept answering on the server while the visitor was away, and shows the whole answer.
		await page
			.getByRole('complementary', { name: 'Conversations' })
			.locator(`a[href$="/conversation/${firstId}"]`)
			.click();
		await page.waitForURL(new RegExp(`/conversation/${firstId}`), { timeout: 30_000 });
		await expect(reply, 'the first chat never showed its whole answer').toContainText(
			LAST_SENTENCE,
			{
				timeout: 60_000
			}
		);
		await expect(stop).toHaveCount(0, { timeout: 30_000 });
		await expect(reply.getByRole('alert')).toHaveCount(0);
	}
);
