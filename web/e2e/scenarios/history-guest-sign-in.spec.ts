// e2e-product: @chat
// e2e-area: @auth @history
// A guest who chats and then signs in keeps their chat: it opens under the account and goes on
//. Signing in moves a guest's conversations to the account
// (migrateAnonymousSession.ts). A guest's chats are written unsealed, even where the guest holds a
// device key, because the guest's history key does not move to the account. Were they sealed to the guest key, the account could not open them and
// every later turn would be refused with "unlock this chat to continue it".
//
// Both kinds of account are walked: a fresh one with no key, and one that already turned encryption
// on in another browser. history-key-enrollment is forced on the documented way (`setFlagOverrides`),
// so the guest's device key is made on its first turn as it would be for a visitor. Sealing is the
// history-seal-writes flag, on for develop and its previews.
import { test, expect, type Page } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { startChattingPastWelcome } from './helpers/welcome';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnOnEncryption } from './helpers/historyKey';
import { turnDone } from './helpers/turn';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');
const answers = (page: Page) => page.locator('[data-message-role="assistant"]');

/** A guest's chat carrying `canary`, after which the guest's device key is on the server. Returns the
 *  conversation id. */
async function guestChat(page: Page, canary: string): Promise<string> {
	await page.goto(chatEntry(), { waitUntil: 'load' });
	await composerHydrated(page);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(`Guest handover check ${canary}: name one river in Wales`);
	const id = await sendOpensConversation(page);
	await expect(turnDone(answers(page).last()), "the guest's turn never finished").toBeVisible({
		timeout: 120_000
	});
	await expect
		.poll(async () => (await page.request.get(KEY_ROUTE)).status(), {
			message: "the guest's device key was never stored, so this walk says nothing about it",
			timeout: 30_000
		})
		.toBe(200);
	return id;
}

/** Signed in now: the guest's chat opens with its words, and a new turn in it answers. */
async function readsAndContinues(page: Page, id: string, canary: string): Promise<void> {
	await page.goto(chatPath(`/conversation/${id}`), { waitUntil: 'load' });
	await expect(
		page.locator('[data-message-type="user"]').filter({ hasText: canary }),
		"the guest's chat did not open under the account"
	).toBeVisible({ timeout: 30_000 });
	await composerHydrated(page);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill('And one in Scotland?');
	await composer.press('Enter');
	await expect(answers(page), 'the turn after signing in never landed').toHaveCount(2, {
		timeout: 60_000
	});
	await expect(
		turnDone(answers(page).last()),
		'the turn after signing in did not answer'
	).toBeVisible({ timeout: 120_000 });
	await expect(
		page.getByText(/unlock this chat to continue it|does not match this chat/)
	).toHaveCount(0);
}

test(
	"a guest's chat opens and goes on after the guest signs in to a new account",
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		const canary = `canary-${Date.now().toString(36)}-sedge-ferry`;
		const id = await guestChat(page, canary);

		await signInAsFreshUser(page);
		await readsAndContinues(page, id, canary);
	}
);

test(
	"a guest's chat opens and goes on after the guest signs in to an account that already has a history key",
	{ tag: ['@preview-only'] },
	async ({ page, context, browser, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the email code cannot be read'
		).toBeTruthy();
		test.setTimeout(360_000);
		const email = freshTestEmail();

		// The account turns encryption on in another browser first.
		const other = await browser.newContext({ baseURL });
		const recoveryKey = await (async () => {
			try {
				await setFlagOverrides(other, baseURL!, { 'history-key-enrollment': true });
				const otherPage = await other.newPage();
				const welcome = otherPage.getByRole('dialog', { name: 'Welcome to Alpha' });
				await otherPage.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
				await signInAsFreshUser(otherPage, email);
				await composerHydrated(otherPage);
				return await turnOnEncryption(otherPage);
			} finally {
				await other.close();
			}
		})();

		// This browser chats as a guest, then signs in to that account and unlocks it.
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		const canary = `canary-${Date.now().toString(36)}-alder-weir`;
		const id = await guestChat(page, canary);

		await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
		const prompt = page.getByTestId('history-key-unlock-prompt');
		await expect(prompt, 'this browser was not asked to unlock the account').toBeVisible({
			timeout: 30_000
		});
		await prompt.getByLabel('Recovery key').fill(recoveryKey);
		await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
		await expect(prompt, 'the unlock prompt stayed open after the recovery key').toBeHidden({
			timeout: 30_000
		});

		await readsAndContinues(page, id, canary);
	}
);
