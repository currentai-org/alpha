import type { Page } from '@playwright/test';
import { testAuthHelpers } from '../../testAuth';
import { freshTestEmail } from './signIn';

// A signed-in person for a spec that is testing something other than sign-in. Mints a fresh
// user and session through the test-only Better Auth instance (e2e/testAuth.ts) and hands the browser
// its cookie, then lands on /chat, where signInWithEmailOtp left the page. Each call is a new
// `e2e-<uuid>@example.org` user, as freshTestEmail() gives the UI walk, because several callers
// delete their own account; cleanup-e2e-artifacts.mjs removes these users by that pattern.
//
// The real sign-in flow stays covered by sign-in.spec.ts, passkey-sign-in.spec.ts and
// mock-oidc-sign-in.spec.ts, which still walk the screen.
export async function signInAsFreshUser(
	page: Page,
	email: string = freshTestEmail()
): Promise<void> {
	const test = await testAuthHelpers();
	const user = test.createUser({ email });
	// A first email-code sign-in stores an empty name (email-otp's `name || ""`); the factory
	// defaults it to "Test User" instead, which would put a name on screen no real account has.
	user.name = '';
	await test.saveUser(user);
	await page.context().addCookies(await test.getCookies({ userId: user.id }));
	await page.goto('/chat');
}
