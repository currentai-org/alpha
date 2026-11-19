// Sign-in on the composed self-host stack, in a browser, from the product. Two modes, one per
// stack configuration, chosen by SELFHOST_SIGNIN_MODE:
//
//   password  The stack as compose boots it: ALPHA_EDITION=selfhost and no mailer (no RESEND_API_KEY, no
//             SMTP_URL). A visitor opens the app, takes "Log in" from the account menu, creates an account
//             with an email and a password, and is signed in; a second browser signs in with the same pair,
//             and a wrong password is refused.
//             Sign-up then closes: a third, fresh browser finds the reason on the sign-in page in
//             place of "New here? Create an account", and the sign-up route itself refuses it.
//   open      The web service recreated with ALPHA_OPEN_SIGNUP=true, after password mode made an account:
//             a fresh browser still creates a second account and is signed in.
//   smtp      The web service recreated with SMTP_URL pointed at Mailpit (.github/selfhost-mailpit.compose.yaml).
//             The same visitor asks for a code, the code is read from the message Mailpit received through
//             its HTTP API, typed into the sign-in page, and the visitor is signed in.
//
// Each test asserts the session through Better Auth's own get-session route, so "signed in" means the
// server holds a session for that address, not that a page looked right. Lines starting
// "SELFHOST SIGNIN" go to the workflow's step summary.
//
// Run by .github/workflows/selfhost-smoke.yml:
//   cd web && SELFHOST_SIGNIN_MODE=password pnpm exec playwright test --config=e2e/selfhost-signin.config.ts
// Environment: SELFHOST_BASE_URL (default http://localhost:3000), MAILPIT_URL (default http://localhost:8025).
import { test, expect, type Browser, type Page } from '@playwright/test';
import { accountMenuItem } from './scenarios/helpers/accountMenu';
import { dismissWelcome } from './selfhost-stack';

const mode = process.env.SELFHOST_SIGNIN_MODE ?? 'password';
const mailpit = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/$/, '');
// Not example.org: the app suppresses every send to that reserved domain (resend.ts isReservedTestAddress).
const address = `selfhost-${mode}-${Date.now()}@alpha-selfhost.test`;
const password = `cur4930-${Math.random().toString(36).slice(2)}-pw`;
// The copy login/+page.svelte shows when sign-up is closed (selfHostSignUp.ts has the server's refusal).
const signUpClosedCopy = 'Sign-up is closed on this server.';

/** From the app's front page to the sign-in page the way a visitor goes: the account menu's "Log in". */
async function openSignInFromProduct(page: Page) {
	await dismissWelcome(page);
	await page.goto('/', { waitUntil: 'domcontentloaded' });
	await (await accountMenuItem(page, 'Log in', { timeout: 60_000 })).click();
	await page.waitForURL(/\/login(\?|$)/, { timeout: 30_000 });
	await expect(page.getByRole('heading', { name: 'Sign in to Alpha' })).toBeVisible({
		timeout: 30_000
	});
}

/** The address Better Auth's session route holds for this browser, or null when signed out. */
async function sessionEmail(page: Page): Promise<string | null> {
	const res = await page.request.get('/chat/api/auth/get-session');
	expect(res.ok(), `get-session answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { user?: { email?: string } } | null;
	return body?.user?.email ?? null;
}

async function leftSignIn(page: Page) {
	await page.waitForURL((u) => !/\/login(\?|$)/.test(u.pathname + u.search), { timeout: 60_000 });
}

async function freshPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext();
	return context.newPage();
}

test.describe.serial(`self-host sign-in, ${mode} (CUR-4930)`, () => {
	if (mode === 'password') {
		test('with no mailer, a visitor reached from the product creates an account with email and password and is signed in', async ({
			page
		}) => {
			await openSignInFromProduct(page);
			// The code route would lock everyone out with no mail, so it is not offered here.
			await expect(page.getByRole('button', { name: 'Continue with email' })).toHaveCount(0);
			await page.getByRole('button', { name: 'New here? Create an account' }).click();
			await page.locator('#signin-email').fill(address);
			await page.locator('#signin-password').fill(password);
			await page.screenshot({ path: test.info().outputPath('create-account.png'), fullPage: true });
			await page.getByRole('button', { name: 'Create account' }).click();
			await leftSignIn(page);
			expect(await sessionEmail(page), 'the new account holds a session').toBe(address);
			await page.screenshot({ path: test.info().outputPath('signed-in.png'), fullPage: true });
			console.log(`SELFHOST SIGNIN ok   password: created ${address} and signed in`);
		});

		test('the same email and password sign in from a second browser, and a wrong password is refused', async ({
			browser
		}) => {
			const page = await freshPage(browser);
			await openSignInFromProduct(page);
			await page.locator('#signin-email').fill(address);
			await page.locator('#signin-password').fill(`${password}-wrong`);
			await page.getByRole('button', { name: 'Sign in with email' }).click();
			await expect(page.getByRole('alert')).toContainText("don't match an account", {
				timeout: 30_000
			});
			expect(await sessionEmail(page), 'a wrong password holds no session').toBeNull();

			await page.locator('#signin-password').fill(password);
			await page.getByRole('button', { name: 'Sign in with email' }).click();
			await leftSignIn(page);
			expect(await sessionEmail(page), 'the account signs back in').toBe(address);
			console.log(
				`SELFHOST SIGNIN ok   password: refused a wrong password, then signed ${address} back in`
			);
		});

		test('after the first account, sign-up is closed: a fresh browser sees why on the sign-in page and the sign-up route refuses it', async ({
			browser
		}) => {
			const page = await freshPage(browser);
			await openSignInFromProduct(page);
			await expect(page.getByTestId('signup-closed')).toContainText(signUpClosedCopy, {
				timeout: 30_000
			});
			await expect(
				page.getByRole('button', { name: 'New here? Create an account' }),
				'no create-account form is offered once sign-up is closed'
			).toHaveCount(0);
			await page.screenshot({ path: test.info().outputPath('signup-closed.png'), fullPage: true });

			// The server refuses too, not only the page: a stale page or a direct request gets the same answer.
			const stranger = `selfhost-stranger-${Date.now()}@alpha-selfhost.test`;
			const res = await page.request.post('/chat/api/auth/sign-up/email', {
				headers: { origin: new URL(page.url()).origin },
				data: { email: stranger, password, name: 'stranger' }
			});
			expect(res.status(), 'the sign-up route refuses a second account').toBe(403);
			expect(((await res.json()) as { code?: string }).code).toBe('SIGN_UP_CLOSED');
			expect(await sessionEmail(page), 'a refused sign-up holds no session').toBeNull();
			console.log(
				`SELFHOST SIGNIN ok   password: sign-up closed after the first account; ${stranger} refused with 403 SIGN_UP_CLOSED`
			);
		});
	} else if (mode === 'open') {
		test('with ALPHA_OPEN_SIGNUP=true, a fresh browser creates another account after the first and is signed in', async ({
			page
		}) => {
			await openSignInFromProduct(page);
			await expect(page.getByTestId('signup-closed'), 'sign-up stays open').toHaveCount(0);
			await page.getByRole('button', { name: 'New here? Create an account' }).click();
			await page.locator('#signin-email').fill(address);
			await page.locator('#signin-password').fill(password);
			await page.getByRole('button', { name: 'Create account' }).click();
			await leftSignIn(page);
			expect(await sessionEmail(page), 'the second account holds a session').toBe(address);
			await page.screenshot({ path: test.info().outputPath('signed-in.png'), fullPage: true });
			console.log(
				`SELFHOST SIGNIN ok   open: ALPHA_OPEN_SIGNUP=true let ${address} sign up after the first account`
			);
		});
	} else {
		test('with SMTP_URL pointed at Mailpit, a visitor reached from the product receives a code by email and signs in', async ({
			page
		}) => {
			await openSignInFromProduct(page);
			await expect(
				page.locator('#signin-password'),
				'a stack with a mailer offers no password'
			).toHaveCount(0);
			await page.locator('#signin-email').fill(address);
			await page.getByRole('button', { name: 'Continue with email' }).click();
			await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({
				timeout: 30_000
			});

			// The message as Mailpit received it over SMTP from the web container.
			let code = '';
			await expect(async () => {
				const search = await page.request.get(`${mailpit}/api/v1/search`, {
					params: { query: `to:"${address}"` }
				});
				expect(search.ok(), `Mailpit search answered ${search.status()}`).toBe(true);
				const found = (await search.json()) as { messages?: { ID: string; Subject?: string }[] };
				const id = found.messages?.[0]?.ID;
				expect(id, `no message to ${address} reached Mailpit`).toBeTruthy();
				const message = (await (
					await page.request.get(`${mailpit}/api/v1/message/${id}`)
				).json()) as {
					Text?: string;
					Subject?: string;
				};
				expect(message.Subject).toBe('Your Alpha sign-in code');
				code = /\b(\d{6})\b/.exec(message.Text ?? '')?.[1] ?? '';
				expect(code, 'the message carries a 6-digit code').toMatch(/^\d{6}$/);
			}).toPass({ timeout: 60_000 });
			console.log(`SELFHOST SIGNIN ok   smtp: Mailpit received the sign-in code for ${address}`);

			// Six digits submit on their own (login/+page.svelte).
			await page.locator('#signin-otp').fill(code);
			await leftSignIn(page);
			expect(await sessionEmail(page), 'the code signed the address in').toBe(address);
			await page.screenshot({ path: test.info().outputPath('signed-in.png'), fullPage: true });
			console.log(`SELFHOST SIGNIN ok   smtp: signed ${address} in with the code from the email`);
		});
	}
});
