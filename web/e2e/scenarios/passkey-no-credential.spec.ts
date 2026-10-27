// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { accountMenuItem } from './helpers/accountMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// A visitor whose device has no passkey taps "Use a passkey", the browser finds nothing to
// offer, and Better Auth's client turns the NotAllowedError into the message "Auth cancelled". This
// drives that path with a virtual authenticator holding no credential and checks the page says what
// to do instead, with the other ways in still on screen.
test(
	'a passkey tap on a device with no passkey points to the other sign-in methods, never a bare "Auth cancelled"',
	{ tag: ['@A1', '@CUR-2924'] },
	async ({ page, context }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		const cdp = await context.newCDPSession(page);
		await cdp.send('WebAuthn.enable', { enableUI: false });
		await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true
			}
		});

		await page.goto('/chat', { waitUntil: 'load' });
		await (await accountMenuItem(page, 'Log in', { timeout: 20_000 })).click();
		const passkeyButton = page.getByRole('button', { name: /^Use a passkey/ });
		await expect(passkeyButton).toBeVisible({ timeout: 15_000 });
		await passkeyButton.click();

		await expect(
			page.getByText(
				/No passkey was used\. If this device doesn't have one for Alpha, sign in with email/
			),
			'a failed passkey tap did not say which other way to sign in'
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText(/^Auth cancelled$/)).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: 'Continue with email' }),
			'the email route was not on screen beside the passkey message'
		).toBeVisible();
	}
);
