// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';

// the input screen reads every user message together, so a distress message kept firing the
// guard's distress log rule on every later turn, and an unrelated follow-up got the Support resources
// card (and the helpline guard then rewrote "Fahrenheit 451" into a findahelpline link). The card now
// needs the distress rule to fire on the turn's own message. A distress message as a later turn still
// gets it.
//
// The support classifier is off, so every card here comes from the guard's own distress rules: the
// classifier reads only the latest message and never had this bug. Tagged @real-screen because the
// screen's verdict is the thing under test, and by ticket so crisis copy stays off demo recordings.
const HOPELESS = 'some days I feel hopeless and wonder what the point is';
const UNRELATED = 'Can you recommend a good science fiction book?';

async function send(page: Page, text: string) {
	const composer = page.getByLabel('Message AI Potluck');
	const replies = page.locator('[data-message-role="assistant"]');
	const before = await replies.count();
	await composer.fill(text);
	await composer.press('Enter');
	// The new reply, never the previous turn's finished one.
	await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
	return replies.nth(before);
}

test(
	'after a distress message, an unrelated follow-up gets no support card, and a later distress message does',
	{ tag: ['@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'self-harm-distress-declines': false,
			'support-signal-classifier': false
		});
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await composerHydrated(page);
		await page.getByLabel('Message AI Potluck').fill(HOPELESS);
		await sendOpensConversation(page);
		const first = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(first), 'the distress turn never finished').toBeVisible({
			timeout: 90_000
		});
		await expect(
			first.getByRole('note', { name: 'Support resources' }),
			'the distress message got no support card, so the follow-up below proves nothing'
		).toBeVisible();

		const followUp = await send(page, UNRELATED);
		await expect(turnDone(followUp), 'the follow-up never finished').toBeVisible({
			timeout: 90_000
		});
		await expect(
			followUp.getByRole('note', { name: 'Support resources' }),
			'the unrelated follow-up carries the support card: the earlier distress message still stamps later turns'
		).toHaveCount(0);
		await expect(
			followUp.getByRole('link', { name: 'findahelpline.com' }),
			'the helpline guard rewrote a number in the unrelated answer, so the turn was still treated as a crisis'
		).toHaveCount(0);

		// After a reload too: the stamp is what persists, not only what streamed.
		await page.reload();
		const reloaded = page.locator('[data-message-role="assistant"]');
		await expect(reloaded).toHaveCount(2, { timeout: 30_000 });
		await expect(
			reloaded.nth(1).getByRole('note', { name: 'Support resources' }),
			'the follow-up carries the support card after a reload: the persisted stamp is wrong'
		).toHaveCount(0);

		const again = await send(page, HOPELESS);
		await expect(turnDone(again), 'the second distress turn never finished').toBeVisible({
			timeout: 90_000
		});
		await expect(
			again.getByRole('note', { name: 'Support resources' }),
			'a distress message as a later turn got no support card: the latest-message check drops a real hit'
		).toBeVisible();
	}
);
