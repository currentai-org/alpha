// e2e-product: @chat
// e2e-area: @composer
import { test, expect } from './helpers/test';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { plusButton } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// A guest who closes the first-run welcome has a settings row under their guest session, and signing in
// carries that row into the new account (migrateAnonymousSession.ts). One PR run that saved the welcome
// this way for every test saw the + menu's Attach files open no file picker after sign-in;
// the cause is not established (CUR-4333). A real visitor takes the
// same path whenever they close the welcome before signing in, so this pins that it keeps working.

// This test closes the welcome itself, so the fixture must not press past it first (SOL-343).
test.use({ welcome: 'show' });

test.beforeEach(async ({ context, baseURL }) => {
	await setFlagOverrides(context, baseURL!, {
		multimodal: true,
		'document-attachments': true,
		'agent-mode': false
	});
});

test(
	'a guest who closes the welcome and then signs in can attach a file from the + menu',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/chat', { waitUntil: 'commit' });
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await expect(welcome, 'a new guest saw no welcome').toBeVisible({ timeout: 30_000 });
		const seenSaved = page.waitForResponse(
			(r) => r.url().endsWith('/settings') && r.request().method() === 'POST',
			{ timeout: 15_000 }
		);
		await startChattingPastWelcome(welcome);
		expect((await seenSaved).ok(), 'closing the welcome saved nothing for the guest').toBe(true);

		await signInAsFreshUser(page);
		await expect(
			page.getByRole('dialog', { name: 'Welcome to Alpha' }),
			'the account showed the welcome again, so the guest row did not carry over'
		).toBeHidden({ timeout: 15_000 });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		await plusButton(page).click({ timeout: 10_000 });
		await expect(
			page.getByTestId('attach-sign-in'),
			'signed in, Attach files still asks the visitor to sign in'
		).toBeHidden();
		const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
		await page.getByRole('menuitem', { name: /^Attach files/ }).click();
		await (
			await chooser
		).setFiles({
			name: 'after-welcome.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('Bring a dish\n')
		});
		await expect(
			page.getByText('after-welcome.txt').first(),
			'the file chosen after signing in never showed as attached'
		).toBeVisible({ timeout: 10_000 });
	}
);
