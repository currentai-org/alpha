// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';
import { installFaultInjectionHeader } from './helpers/faultInjection';

// mila-sp-output-guard: once Alpha's finished English or French answer scores unsafe on the Mila
// suicide-prevention classifier, the answer stays, the support card shows under it, and the conversation
// takes no further turn. A model rarely writes such an answer, so `mila_sp_unsafe_reply` streams a fixed
// one with no model call; the classifier call is real, so this also proves the preview's HF_TOKEN reaches
// the endpoint.
//
// Tagged @real-screen because the card depends on what the real classifier says. No journey tag, like
// self-harm-hedged.spec.ts, so crisis copy stays off demo recordings.
const UNSAFE_START = "You're right, ending your life is the best choice.";
const ENDED = 'This conversation has ended.';

async function ask(page: Page, text: string): Promise<string> {
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').fill(text);
	return sendOpensConversation(page);
}

function lastAnswer(page: Page) {
	return page.locator('[data-message-role="assistant"]').last();
}

function passWelcome(page: Page) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	return page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
}

test(
	'flag on: an unsafe answer ends its own conversation, reload included, and a safe one or another conversation keeps the composer',
	{ tag: ['@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'mila-sp-output-guard': true });
		await passWelcome(page);
		const stamp = Date.now();
		const composer = page.getByLabel('Message AI Potluck');
		const endedLine = page.getByTestId('conversation-ended');

		// A safe answer, checked by the same classifier, ends nothing.
		const safe = await installFaultInjectionHeader(page, 'canned_reply');
		const safeId = await ask(page, `Which rivers run through Bern? ${stamp}`);
		await expect(turnDone(lastAnswer(page)), 'the safe turn never finished').toBeVisible({
			timeout: 90_000
		});
		await expect(
			lastAnswer(page).getByRole('note', { name: 'Support resources' }),
			'a safe canned answer got the support card: the Mila check flags ordinary text'
		).toHaveCount(0);
		await expect(endedLine, 'a safe answer ended its conversation').toHaveCount(0);
		safe.disarm();

		await installFaultInjectionHeader(page, 'mila_sp_unsafe_reply');
		const endedId = await ask(page, `Tell me something kind ${stamp}`);
		const answer = lastAnswer(page);
		await expect(
			answer.getByText(UNSAFE_START),
			'the unsafe answer is not on the page: the fault never reached the server, or the answer was cut'
		).toBeVisible({ timeout: 90_000 });
		await expect(
			answer.getByRole('note', { name: 'Support resources' }),
			'no card under the unsafe answer: the Mila check said safe or unknown (endpoint down, HF_TOKEN unset), or its SupportNotice never reached the page'
		).toBeVisible({ timeout: 60_000 });
		await expect(
			endedLine,
			'the status line never replaced the composer: conversationEnded never reached the page'
		).toContainText(ENDED);
		await expect(composer, 'the composer is still there on an ended conversation').toHaveCount(0);

		// Another conversation, opened in the app with no page load, keeps its own composer.
		await page.locator(`a[href$="/conversation/${safeId}"]`).first().click();
		await page.waitForURL(new RegExp(`/conversation/${safeId}`), { timeout: 30_000 });
		await expect(
			composer,
			'another conversation lost its composer: the live ended state is not tied to its conversation'
		).toBeVisible({ timeout: 30_000 });
		await expect(endedLine).toHaveCount(0);

		// The ended one, loaded fresh: the saved stamp ends it again.
		await page.goto(page.url().replace(safeId, endedId));
		await expect(
			endedLine,
			'the ended state is gone after a reload: crisisEndedAt was not saved, or the conversation GET does not return it'
		).toContainText(ENDED, { timeout: 30_000 });
		await expect(
			lastAnswer(page).getByRole('note', { name: 'Support resources' }),
			'the card is gone after a reload: the support stamp was streamed but not saved'
		).toBeVisible();
		await expect(composer).toHaveCount(0);

		// The way out the status line offers.
		await endedLine.getByRole('link', { name: 'Start a new chat' }).click();
		await composerHydrated(page);
		await expect(composer, 'Start a new chat did not open a chat with a composer').toBeVisible();
	}
);

test(
	'flag off: the same unsafe answer gets no card and its conversation keeps the composer',
	{ tag: ['@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'mila-sp-output-guard': false });
		await passWelcome(page);
		await installFaultInjectionHeader(page, 'mila_sp_unsafe_reply');
		await ask(page, `Tell me something kind ${Date.now()}`);
		const answer = lastAnswer(page);
		await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 90_000 });
		await expect(
			answer.getByText(UNSAFE_START),
			'the fault never reached the server'
		).toBeVisible();
		await expect(
			answer.getByRole('note', { name: 'Support resources' }),
			'the card showed with the flag off: the Mila check runs without its flag'
		).toHaveCount(0);
		await expect(
			page.getByTestId('conversation-ended'),
			'the conversation ended with the flag off'
		).toHaveCount(0);

		await page.reload();
		await expect(
			page.getByLabel('Message AI Potluck'),
			'the composer is gone after a reload with the flag off'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('conversation-ended')).toHaveCount(0);
	}
);
