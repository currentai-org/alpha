// e2e-product: @chat
// e2e-area: @auth @history
// Encrypted chat history is opt-in from Settings. A signed-in person is asked nothing at sign-in,
// and their chats are stored as before. In
// Settings → Account → Your key they choose "Encrypt my chat history", which can't turn on until a
// recovery key (typed back) or a PRF passkey exists, and says plainly that losing every way in loses the
// history. Turning it on seals the chats they already have to the new key, and deletes none. In a fresh
// browser the same person meets the unlock prompt and opens the key with the recovery key. With two tabs
// turning it on at once, the recovery key saved in the tab that answered second is added to the key the
// first stored. A guest's device key is still made silently on the first turn. Two junk wraps uploaded
// over the key, as a stolen session could, leave the browser that turned it on still opening its sealed
// chat.
//
// The flag is forced the documented way (`setFlagOverrides`) in every browser: it is team-only on
// preview, so an example.org account would not get it otherwise. Sealing is the history-seal-writes
// flag, on for develop and its previews.
import { test, expect, type Page } from './helpers/test';
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { startChattingPastWelcome } from './helpers/welcome';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { journeyStep } from './helpers/journeyStep';
import { readConversationDoc } from './helpers/exportArchive';
import {
	freshAccountWithHistoryKey,
	openYourKey,
	saveRecoveryKeyIn,
	shownRecoveryKey,
	turnOnEncryption
} from './helpers/historyKey';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');

type StoredDoc = {
	title?: string;
	sealedTitle?: string;
	messages: { id: string; from: string; content?: string; sealed?: string }[];
};

const keyStatus = async (page: Page) => (await page.request.get(KEY_ROUTE)).status();

test(
	'a signed-in person is asked nothing at sign-in, turns on encryption from Settings only once a recovery key is saved, and their existing chat is sealed with nothing deleted',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		const email = freshTestEmail();
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);

		// From /chat, through the rail's Log in, as a person would.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await signInWithEmailOtp(page, DATABASE_URL!, email, {
			viaNavLink: true,
			// The rail's Log in returns the person to the page they left, which is the model page whenever
			// SCENARIO_MODEL is set (the journey gallery sets it).
			landsOn: new RegExp(`${chatEntry()}/?([?#]|$)`),
			skipPendingLabelCheck: true
		});
		await composerHydrated(page);

		// No key dialog of any kind stands between the person and the composer, and they chat as before.
		const canary = `canary-${Date.now().toString(36)}-plover-shoal`;
		const id = await journeyStep(page, 'A3', 30, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await expect(page.getByRole('alertdialog')).toHaveCount(0);
			await expect(page.getByTestId('history-key-opt-in')).toHaveCount(0);
			await composer.fill(`Opt-in seal check ${canary}: name one wading bird`);
			const conversation = await sendOpensConversation(page);
			await expect(
				turnDone(page.locator('[data-message-role="assistant"]').last()),
				'the turn never finished'
			).toBeVisible({ timeout: 120_000 });
			return conversation;
		});
		expect(await keyStatus(page), 'a key was stored with nobody choosing one').toBe(404);
		const before = (await readConversationDoc(DATABASE_URL!, id)) as unknown as StoredDoc;
		expect(JSON.stringify(before), 'the chat before opting in was not stored as before').toContain(
			canary
		);
		const messageIds = before.messages.map((m) => m.id);

		await journeyStep(page, 'A3', 31, async () => {
			const section = await openYourKey(page);
			await section.getByRole('button', { name: 'Encrypt my chat history' }).click();
			const dialog = page.getByTestId('history-key-opt-in');
			await expect(dialog).toBeVisible({ timeout: 20_000 });
			await expect(dialog.getByTestId('history-key-loss-warning')).toHaveText(
				"If you lose every way in, your chat history is lost for good. AI Potluck can't recover it."
			);
			// Refused without a recovery method: turning on waits for one, and nothing is stored.
			await expect(dialog.getByRole('button', { name: 'Turn on encryption' })).toBeDisabled();
			await expect(dialog.getByRole('button', { name: /accept losing/i })).toHaveCount(0);
			await dialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(dialog).toBeHidden();
			expect(await keyStatus(page), 'a key was stored with no recovery method').toBe(404);

			await section.getByRole('button', { name: 'Encrypt my chat history' }).click();
			await expect(dialog).toBeVisible({ timeout: 20_000 });
			await dialog.getByRole('button', { name: 'Save a recovery key' }).click();
			const recoveryKey = await shownRecoveryKey(dialog);
			await dialog.getByRole('button', { name: "I've saved it" }).click();
			// A wrong key typed back is refused before anything is stored.
			const typedBack = dialog.getByLabel('Type or paste your recovery key');
			await typedBack.fill(recoveryKey.slice(0, -2) + 'QQ');
			await dialog.getByRole('button', { name: 'Confirm recovery key' }).click();
			await expect(dialog.getByText("That doesn't match the key shown.")).toBeVisible();
			await typedBack.fill(recoveryKey);
			await dialog.getByRole('button', { name: 'Confirm recovery key' }).click();
			await expect(dialog.getByTestId('history-key-method-ready')).toHaveText('Recovery key saved');
			expect(await keyStatus(page), 'a key was stored before encryption was turned on').toBe(404);

			await dialog.getByRole('button', { name: 'Turn on encryption' }).click();
			await expect(dialog, 'the dialog stayed open after turning encryption on').toBeHidden({
				timeout: 60_000
			});
			// The server says the chats already there were sealed, and the section says so only then.
			await expect(section.getByTestId('history-key-turned-on')).toHaveAttribute(
				'data-existing-chats',
				'sealed'
			);
			await expect(section.getByTestId('history-key-turned-on')).toHaveText(
				'Encryption is on. Your existing chats are sealed to your key.'
			);
			await expect(
				section.locator('[data-testid="history-key-way"][data-kind="recovery"]')
			).toHaveCount(1);
			await expect(
				section.getByTestId('history-key-way').filter({ hasText: 'This browser' })
			).toHaveCount(1);
		});
		expect(await keyStatus(page), 'the server holds no history key after turning it on').toBe(200);

		// The chat from before is sealed to the new key: no word of it is left in the row, and every
		// message is still there.
		const after = (await readConversationDoc(DATABASE_URL!, id)) as unknown as StoredDoc;
		expect(JSON.stringify(after), 'the canary is still readable in the stored row').not.toContain(
			canary
		);
		expect(
			after.messages.map((m) => m.id),
			'a message was deleted'
		).toEqual(messageIds);
		expect(
			after.messages.filter((m) => m.from !== 'system').every((m) => m.sealed),
			'a message of the existing chat was left unsealed'
		).toBe(true);

		// After a reload this browser opens it again, words and all.
		await page.goto(chatPath(`/conversation/${id}`), { waitUntil: 'load' });
		await expect(
			page.locator('[data-message-type="user"]').filter({ hasText: canary }),
			'the sealed chat did not open after a reload'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('[data-message-role="assistant"]').last()).toBeVisible();
		await expect(page.getByTestId('history-key-unlock-prompt')).toHaveCount(0);
	}
);

test(
	'after turning encryption on, a fresh browser unlocks with the recovery key and lists both ways in',
	{ tag: ['@preview-only'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(240_000);
		const email = freshTestEmail();
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await signInWithEmailOtp(page, DATABASE_URL!, email, {
			viaNavLink: true,
			landsOn: new RegExp(`${chatEntry()}/?([?#]|$)`),
			skipPendingLabelCheck: true
		});
		await composerHydrated(page);
		const recoveryKey = await turnOnEncryption(page);
		const { recipient } = (await (await page.request.get(KEY_ROUTE)).json()) as {
			recipient: string;
		};
		expect(recipient).toMatch(/^age1pq1/);

		// Reloading the browser that turned it on asks nothing: its device key opens the key.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		await expect(page.getByTestId('history-key-unlock-prompt')).toHaveCount(0);

		const other = await browser.newContext({ baseURL });
		try {
			await setFlagOverrides(other, baseURL!, { 'history-key-enrollment': true });
			const otherPage = await other.newPage();
			const welcome = otherPage.getByRole('dialog', { name: 'Welcome to Alpha' });
			await otherPage.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
			await signInWithEmailOtp(otherPage, DATABASE_URL!, email, { skipPendingLabelCheck: true });

			const prompt = otherPage.getByTestId('history-key-unlock-prompt');
			await expect(prompt, 'a fresh browser was not asked to unlock').toBeVisible({
				timeout: 30_000
			});
			await prompt.getByLabel('Recovery key').fill(recoveryKey);
			await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
			await expect(prompt, 'the unlock prompt stayed open after the recovery key').toBeHidden({
				timeout: 30_000
			});

			await otherPage.goto(chatPath('/settings/account'), { waitUntil: 'load' });
			const section = otherPage.getByTestId('history-key-section');
			await expect(section.getByRole('heading', { name: 'Your key' })).toBeVisible({
				timeout: 30_000
			});
			const ways = section.getByTestId('history-key-way');
			await expect(ways.filter({ hasText: 'Recovery key' }).first()).toBeVisible({
				timeout: 30_000
			});
			await expect(
				section.locator('[data-testid="history-key-way"][data-kind="recovery"]')
			).toHaveCount(1);
			await expect(ways.filter({ hasText: 'This browser' })).toHaveCount(1);
			// The first browser stays a way in beside this one.
			await expect(
				section.locator('[data-testid="history-key-way"][data-kind="device"]')
			).toHaveCount(2);

			// The same key is still on the server: the unlock rewrapped it, never replaced it.
			const after = (await (await otherPage.request.get(KEY_ROUTE)).json()) as {
				recipient: string;
			};
			expect(after.recipient).toBe(recipient);
		} finally {
			await other.close();
		}
	}
);

test(
	'with two tabs turning encryption on, the recovery key saved in the tab that answered second is kept and unlocks a fresh browser',
	{ tag: ['@preview-only'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await signInAsFreshUser(page);
		await composerHydrated(page);

		// Both tabs open the dialog and save a recovery key before either turns encryption on.
		const sectionA = await openYourKey(page);
		await sectionA.getByRole('button', { name: 'Encrypt my chat history' }).click();
		const dialogA = page.getByTestId('history-key-opt-in');
		await saveRecoveryKeyIn(dialogA);

		const tabB = await context.newPage();
		await tabB.goto(chatPath('/settings/account'), { waitUntil: 'load' });
		const sectionB = tabB.getByTestId('history-key-section');
		await sectionB
			.getByRole('button', { name: 'Encrypt my chat history' })
			.click({ timeout: 30_000 });
		const dialogB = tabB.getByTestId('history-key-opt-in');
		const recoveryKeyB = await saveRecoveryKeyIn(dialogB);

		// Tab A turns it on first.
		await dialogA.getByRole('button', { name: 'Turn on encryption' }).click();
		await expect(dialogA, 'tab A stayed open after turning encryption on').toBeHidden({
			timeout: 60_000
		});
		const first = (await (await page.request.get(KEY_ROUTE)).json()) as { recipient: string };

		// Tab B turns it on against a key that is no longer missing: its recovery key joins A's key.
		await dialogB.getByRole('button', { name: 'Turn on encryption' }).click();
		await expect(dialogB, 'tab B stayed open after its recovery key was kept').toBeHidden({
			timeout: 60_000
		});
		await expect(tabB.getByTestId('history-key-not-kept')).toHaveCount(0);
		const second = (await (await tabB.request.get(KEY_ROUTE)).json()) as { recipient: string };
		expect(second.recipient, 'tab B replaced the key tab A stored').toBe(first.recipient);
		await expect(
			sectionB.locator('[data-testid="history-key-way"][data-kind="recovery"]')
		).toHaveCount(2);

		// A fresh browser opens the account's key with tab B's recovery key.
		const other = await browser.newContext({ baseURL });
		try {
			await setFlagOverrides(other, baseURL!, { 'history-key-enrollment': true });
			await other.addCookies(await context.cookies());
			const otherPage = await other.newPage();
			const otherWelcome = otherPage.getByRole('dialog', { name: 'Welcome to Alpha' });
			await otherPage.addLocatorHandler(otherWelcome, () => startChattingPastWelcome(otherWelcome));
			await otherPage.goto(chatEntry(), { waitUntil: 'load' });
			const prompt = otherPage.getByTestId('history-key-unlock-prompt');
			await expect(prompt, 'a fresh browser was not asked to unlock').toBeVisible({
				timeout: 30_000
			});
			await prompt.getByLabel('Recovery key').fill(recoveryKeyB);
			await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
			await expect(prompt, "tab B's recovery key did not open the account's key").toBeHidden({
				timeout: 30_000
			});
			await expect(prompt.getByRole('alert')).toHaveCount(0);
		} finally {
			await other.close();
		}
	}
);

test(
	"a guest's device key is made on the first turn, with no prompt",
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		expect((await page.request.get(KEY_ROUTE)).status(), 'a guest had a key before any turn').toBe(
			404
		);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`History key guest check ${Date.now()}: name one lake in Finland`);
		await sendOpensConversation(page);
		await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 120_000
		});

		await expect
			.poll(async () => (await page.request.get(KEY_ROUTE)).status(), {
				message: "the guest's device key was never stored",
				timeout: 30_000
			})
			.toBe(200);
		await expect(page.getByTestId('history-key-unlock-prompt')).toHaveCount(0);

		// The guest reloads and still has their chat.
		await page.reload({ waitUntil: 'load' });
		await expect(page.locator('[data-message-role="assistant"]').last()).toBeVisible({
			timeout: 30_000
		});
		await expect(page.getByTestId('history-key-unlock-prompt')).toHaveCount(0);
	}
);

test(
	'with history-key-enrollment off, Your key is not in Settings and no key is stored',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': false });
		await signInAsFreshUser(page);
		await composerHydrated(page);

		await page.goto(chatPath('/settings/account'), { waitUntil: 'load' });
		await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible({
			timeout: 30_000
		});
		await expect(page.getByTestId('history-key-section')).toHaveCount(0);
		await expect(page.getByTestId('history-key-opt-in')).toHaveCount(0);
		// Nothing asked the server to keep a key.
		expect((await page.request.get(KEY_ROUTE)).status(), 'a key was stored with the flag off').toBe(
			404
		);
	}
);

test(
	'after two junk rewraps of the key, the browser that turned encryption on still opens its sealed chat with no unlock prompt',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		await freshAccountWithHistoryKey(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Junk rewrap check ${Date.now()}: name one estuary bird`);
		const id = await sendOpensConversation(page);
		await expect(
			turnDone(page.locator('[data-message-role="assistant"]').last()),
			'the first turn never finished'
		).toBeVisible({ timeout: 120_000 });

		// The canary goes in a second turn, from a page that has opened the chat with the key.
		const canary = `canary-${Date.now().toString(36)}-curlew-ledger`;
		await page.reload({ waitUntil: 'load' });
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Remember the code word ${canary} and say it back`);
		await composer.press('Enter');
		await expect(
			turnDone(page.locator('[data-message-role="assistant"]').last()),
			'the canary turn never finished'
		).toBeVisible({ timeout: 120_000 });
		const stored = (await readConversationDoc(DATABASE_URL!, id)) as unknown as StoredDoc;
		expect(
			JSON.stringify(stored),
			'the canary is stored in plaintext, so opening the chat would prove nothing about the key'
		).not.toContain(canary);

		// Two junk wraps under the same recipient: the uploads a stolen session cookie allows.
		const original = (await (await page.request.get(KEY_ROUTE)).json()) as {
			wrapped: string;
			recipient: string;
		};
		for (let i = 1; i <= 2; i++) {
			const { hash } = (await (await page.request.get(KEY_ROUTE)).json()) as { hash: string };
			const junk = new Encrypter();
			junk.addRecipient(await identityToRecipient(await generateX25519Identity()));
			const wrapped = Buffer.from(await junk.encrypt('junk')).toString('base64');
			const res = await page.request.put(KEY_ROUTE, {
				data: { format: 2, wrapped, recipient: original.recipient, replaces: hash }
			});
			expect(res.status(), `junk rewrap ${i} was refused, so the attack was never staged`).toBe(
				200
			);
		}
		const newest = (await (await page.request.get(KEY_ROUTE)).json()) as { wrapped: string };
		expect(newest.wrapped, 'the server still serves the original wrap first').not.toBe(
			original.wrapped
		);

		// The browser that turned it on reloads the chat and reads it, asked nothing.
		await page.goto(chatPath(`/conversation/${id}`), { waitUntil: 'load' });
		await expect(
			page.getByText(canary).first(),
			'the sealed chat did not open after two junk rewraps'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('history-key-unlock-prompt')).toHaveCount(0);
	}
);
