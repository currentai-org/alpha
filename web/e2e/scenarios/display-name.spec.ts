// e2e-product: @chat
// e2e-area: @auth @settings
import { test, expect } from './helpers/test';
import { freshTestEmail } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { holdForRecording } from './helpers/recording';
import { startChattingPastWelcome } from './helpers/welcome';

// An email-code account starts with no name, so the account menu and a shared workspace
// showed its bare email, and nothing in the app could change that. Settings → Account now has a
// "Display name" field. The menu reads the name from the app's own user row, which is copied once at
// first sign-in, so this walks the whole path: save, then see the menu and a fresh page load carry it.
test.describe('display name', () => {
	test(
		'a signed-in person sets a display name on Settings → Account, and the account menu shows it after a reload',
		{ tag: '@A1' },
		async ({ page }) => {
			const email = freshTestEmail();
			// The welcome covers the whole app, rail included, so the account menu waits for it to close.
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await signInAsFreshUser(page, email);

			// No name yet: the menu falls back to the email.
			await expect(accountButton(page)).toHaveAccessibleName(`Account — signed in as ${email}`, {
				timeout: 20_000
			});

			await (await accountMenuItem(page, 'Account', { timeout: 20_000 })).click();
			await expect(page).toHaveURL(/\/chat\/settings\/account$/);

			const field = page.getByLabel('Display name');
			await expect(field).toBeVisible({ timeout: 20_000 });
			await expect(field, 'an account with no name starts with an empty field').toHaveValue('');
			const save = page.getByRole('button', { name: 'Save' });
			await expect(save, 'nothing to save until something is typed').toBeDisabled();

			const name = `Ada ${Date.now().toString(36)}`;
			await field.fill(name);
			await save.click();
			await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible({
				timeout: 15_000
			});
			await expect(accountButton(page)).toHaveAccessibleName(`Account — signed in as ${name}`, {
				timeout: 15_000
			});
			await holdForRecording(page);

			// The name lives on the server, not only in this page's state.
			await page.reload({ waitUntil: 'load' });
			await expect(page.getByLabel('Display name')).toHaveValue(name, { timeout: 20_000 });
			await expect(accountButton(page)).toHaveAccessibleName(`Account — signed in as ${name}`);
		}
	);
});
