import { expect, type Locator, type Page } from '@playwright/test';
import { accountMenuItem } from './accountMenu';
import { chatEntry, chatPath } from './chatEntry';
import { composerHydrated } from './composer';
import { signInAsFreshUser } from './session';

// Encrypted chat history is something a signed-in person turns on in Settings → Account → Your key,
// never a step at sign-in. These are the steps a person takes there, shared by the specs
// that need an account with a history key.

/** The recovery key shown once it has been made. */
export async function shownRecoveryKey(scope: Page | Locator): Promise<string> {
	const value = scope.getByTestId('recovery-key-value');
	await expect(value, 'the recovery key was never shown').toHaveText(/^AGE-SECRET-KEY-PQ-1/, {
		timeout: 20_000
	});
	return (await value.textContent())!.trim();
}

/** Account menu → Account, as a person reaches the Your key section from a chat page. */
export async function openYourKey(page: Page): Promise<Locator> {
	await (await accountMenuItem(page, 'Account', { timeout: 20_000 })).click();
	await expect(page).toHaveURL(/\/chat\/settings\/account$/, { timeout: 15_000 });
	const section = page.getByTestId('history-key-section');
	await expect(section.getByRole('heading', { name: 'Your key' })).toBeVisible({ timeout: 30_000 });
	return section;
}

/** In an open "Encrypt my chat history" dialog: save a recovery key and type it back. Returns it. */
export async function saveRecoveryKeyIn(dialog: Locator): Promise<string> {
	await dialog.getByRole('button', { name: 'Save a recovery key' }).click();
	const recoveryKey = await shownRecoveryKey(dialog);
	await dialog.getByRole('button', { name: "I've saved it" }).click();
	await dialog.getByLabel('Type or paste your recovery key').fill(recoveryKey);
	await dialog.getByRole('button', { name: 'Confirm recovery key' }).click();
	await expect(dialog.getByTestId('history-key-method-ready')).toHaveText('Recovery key saved');
	return recoveryKey;
}

/**
 * From any chat page, turn encryption on with a recovery key, the way a person does, and wait until
 * the server holds the key. Returns the recovery key.
 */
export async function turnOnEncryption(page: Page): Promise<string> {
	const section = await openYourKey(page);
	await section.getByRole('button', { name: 'Encrypt my chat history' }).click();
	const dialog = page.getByTestId('history-key-opt-in');
	await expect(dialog).toBeVisible({ timeout: 20_000 });
	const recoveryKey = await saveRecoveryKeyIn(dialog);
	await dialog.getByRole('button', { name: 'Turn on encryption' }).click();
	await expect(dialog, 'the dialog stayed open after turning encryption on').toBeHidden({
		timeout: 60_000
	});
	await expect(section.getByTestId('history-key-turned-on')).toBeVisible();
	return recoveryKey;
}

/**
 * A fresh account that has turned encryption on, back on the chat entry page with the composer ready:
 * the owner a sealing spec writes for. A guest is not one: a guest's chats are not sealed until a
 * sign-in handover moves the guest key to the account. `entry` is the page it ends on (a
 * pinned model's, say). Returns the recovery key.
 */
export async function freshAccountWithHistoryKey(
	page: Page,
	entry: string = chatEntry()
): Promise<string> {
	await signInAsFreshUser(page);
	await composerHydrated(page);
	const recoveryKey = await turnOnEncryption(page);
	await expect
		.poll(async () => (await page.request.get(chatPath('/api/v2/keys/history'))).status(), {
			message: "the account's history key was never stored",
			timeout: 30_000
		})
		.toBe(200);
	await page.goto(entry, { waitUntil: 'load' });
	await composerHydrated(page);
	return recoveryKey;
}
