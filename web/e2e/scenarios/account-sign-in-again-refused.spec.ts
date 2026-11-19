// e2e-product: @chat
// e2e-area: @settings @auth
import postgres from 'postgres';
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { freshTestEmail } from './helpers/signIn';
import { sslFor } from './helpers/db';

// The account page's "Sign in again". Better Auth gates the active-sessions list on a
// session younger than a day, so an older session sees "Sign in again" in its place. That button
// signs out first; Better Auth answers a refused sign-out with { error } rather than throwing, and
// before the fix the page went on to /login with the session still live, which bounced straight back
// here with the same button and no word of why. When the sign-out is refused, the page has to say so,
// stay where it is, and leave the button ready for another try.

test(
	'a refused sign-out behind Sign in again says so on the account page and leaves the button ready',
	{ tag: ['@CUR-4011'] },
	async ({ page }) => {
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');

		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		// Age this account's session past Better Auth's one-day freshness window, so the account page
		// shows the Sign in again state a person signed in since yesterday sees.
		const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
		try {
			const aged = await sql`
				update session set created_at = now() - interval '3 days'
				where user_id = (select id from "user" where email = ${email})
				returning id
			`;
			expect(aged.length, 'the minted session was not found to age').toBeGreaterThan(0);
		} finally {
			await sql.end();
		}

		await page.goto('/chat/settings/account');
		const signInAgain = page.getByRole('button', { name: 'Sign in again' });
		await expect(signInAgain, 'an older session does not see Sign in again').toBeVisible();

		let signOutCalls = 0;
		await page.route('**/chat/api/auth/sign-out', async (route) => {
			signOutCalls++;
			if (signOutCalls === 1) {
				await route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' })
				});
				return;
			}
			await route.continue();
		});
		const logoutPosts: string[] = [];
		page.on('request', (req) => {
			if (req.method() === 'POST' && new URL(req.url()).pathname === '/chat/logout')
				logoutPosts.push(req.url());
		});

		await signInAgain.click();

		await expect(
			page.getByText("Signing out didn't go through, so you're still signed in here."),
			'the refused sign-out is not explained on the page'
		).toBeVisible();
		expect(signOutCalls, 'Sign in again never asked to sign out').toBe(1);
		await expect(page, 'the page left for sign-in with the session still live').toHaveURL(
			/\/chat\/settings\/account/
		);
		await expect(signInAgain, 'Sign in again is not ready for another try').toBeEnabled();
		expect(logoutPosts, 'the page went on to log out after the sign-out was refused').toEqual([]);
	}
);
