// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import postgres from 'postgres';
import { sslFor } from './helpers/db';
import { chatEntry } from './helpers/chatEntry';
import { accountMenuItem } from './helpers/accountMenu';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { watchForChatLanding } from './helpers/landingWatch';
import { journeyStep } from './helpers/journeyStep';
import { signInWithEmailOtp } from './helpers/signIn';
import { startChattingPastWelcome } from './helpers/welcome';

// Google and GitHub sign-in end to end, through the code-for-token exchange and the profile
// read, on Better Auth's own built-in providers with no real account (CUR-1552). oauth-authorize-url.spec.ts
// covers the authorize URL; this covers everything after it.
//
// @local-mock only: Better Auth compiles both providers' URLs in, so the local sign-in leg
// (scripts/sign-in-local.sh) loads e2e/local/provider-redirect.mjs into the app's process, which sends
// the server's token, profile and key calls to the mock provider beside it (mock-oidc/server.mjs). In
// the browser, this spec routes the provider's authorize page to the mock's, which answers straight
// back with a code. Nothing here reaches Google or GitHub.
//
// The mock issues one fixed identity per provider, so each test asserts that exact email came back in
// the session. Anything else means the chain is wired wrong.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const MOCK_ORIGIN = (process.env.MOCK_OIDC_PROVIDER_URL ?? '').replace(/\/+$/, '');

const PROVIDERS = [
	{
		name: 'Google',
		id: 'google',
		authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
		email: 'mock-google-e2e@example.org'
	},
	{
		name: 'GitHub',
		id: 'github',
		authorize: 'https://github.com/login/oauth/authorize',
		email: 'mock-github-e2e@example.org'
	}
] as const;

/** Deletes test users by email; session and account rows cascade. Test identities only. */
async function deleteTestUsers(emails: string[]): Promise<void> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		await sql`delete from "user" where email in ${sql(emails)}`;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

// The tests below share the two fixed accounts above and this file's afterAll deletes them,
// so they stay on one worker under the config's fullyParallel (CUR-3916). 'default' keeps them in order on one
// worker without serial mode's skip-the-rest-on-a-failure.
test.describe.configure({ mode: 'default' });

test.afterAll(async () => {
	await deleteTestUsers(PROVIDERS.map((p) => p.email));
});

for (const provider of PROVIDERS) {
	test(
		`a person can sign in with ${provider.name} end to end, and the session carries the ${provider.name} account's email`,
		{ tag: ['@A1', '@local-mock'] },
		async ({ page, baseURL }) => {
			// The browser leg: the provider's authorize page becomes the mock's, same query string.
			let routed = false;
			await page.route(
				(url) => `${url.origin}${url.pathname}` === provider.authorize,
				async (route) => {
					routed = true;
					const { search } = new URL(route.request().url());
					await route.fulfill({
						status: 302,
						headers: { location: `${MOCK_ORIGIN}/authorize${search}` }
					});
				}
			);

			// CUR-2758: a1-sign-in.md row 4, from the chooser to landing back signed in.
			await journeyStep(
				page,
				'A1',
				4,
				async () => {
					await page.goto('/chat/login', { waitUntil: 'load' });
					// The login page is already on the app's origin, so wait for the callback to answer first.
					const callback = page.waitForResponse((r) => r.url().includes('/api/auth/callback/'), {
						timeout: 60_000
					});
					// Clicks before hydration do nothing, so keep clicking until the sign-in request leaves. The
					// first walk of a run meets a cold `vite dev`, which took 30s to serve the login page's ~575
					// modules in CI, hence the 75s budget. Both waits sit in one Promise.all so
					// a request wait that times out mid-click hands toPass something to retry.
					test.setTimeout(150_000);
					const button = page.getByRole('button', { name: `Continue with ${provider.name}` });
					await expect(async () => {
						await Promise.all([
							page.waitForRequest((r) => r.url().endsWith('/api/auth/sign-in/social'), {
								timeout: 5_000
							}),
							button.click({ timeout: 5_000 })
						]);
					}).toPass({ timeout: 75_000 });
					await callback;
					await page.waitForURL(
						(url) =>
							url.origin === new URL(baseURL!).origin && !url.pathname.includes('/callback/'),
						{ timeout: 30_000 }
					);
				},
				provider.name
			);
			expect(
				routed,
				`the ${provider.name} button never sent the browser to ${provider.authorize}`
			).toBe(true);
			expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();

			// The landing page may navigate again after the callback, so read the session outside the page,
			// with the same cookies.
			const res = await page.request.get('/chat/api/auth/get-session');
			expect(res.status(), `get-session answered ${await res.text()}`).toBe(200);
			const session = (await res.json()) as { user?: { email?: string } } | null;
			expect(session?.user?.email).toBe(provider.email);
		}
	);
}

// A person who changes the email on their Google account keeps one Alpha account, under the
// new address (CUR-3249). Better Auth finds a returning OAuth user by the provider's id, so the first sign-in's
// address used to stay for good; an email code at the new one then opened a second, empty account.
// The mock signs this test in as its own variant identity (mock-oidc/server.mjs), so the other Google
// tests, which may run at the same time, keep theirs.
test(
	'a Google account whose email changed signs in under the new address, and an email code there reaches the same account',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page: firstPage, context, baseURL }) => {
		test.setTimeout(240_000);
		let page = firstPage;
		const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const sub = `mock-google-e2e-${tag}`;
		const before = `${sub}-before@example.org`;
		const after = `${sub}-after@example.org`;
		const google = PROVIDERS[0];
		let providerEmail = before;
		await context.route(
			(url) => `${url.origin}${url.pathname}` === google.authorize,
			async (route) => {
				const target = new URL(`${MOCK_ORIGIN}/authorize${new URL(route.request().url()).search}`);
				target.searchParams.set('mock_sub', sub);
				target.searchParams.set('mock_email', providerEmail);
				await route.fulfill({ status: 302, headers: { location: target.toString() } });
			}
		);
		const sessionUser = async () => {
			const res = await page.request.get('/chat/api/auth/get-session');
			return ((await res.json()) as { user?: { id?: string; email?: string } } | null)?.user;
		};
		const freshPage = async () => {
			const previous = page;
			page = await context.newPage();
			// Nothing reads the old page again, so don't wait on its close: a landing still loading its
			// assets through the context's cache route held close() until the test timed out (CUR-4058).
			void previous.close().catch(() => {});
		};
		const signInWithGoogle = async () => {
			// The landing after the last sign-in keeps navigating once its cookies are cleared, which
			// aborts any goto on it (even to about:blank), so each sign-in starts on a fresh page.
			await freshPage();
			await page.goto('/chat/login', { waitUntil: 'load' });
			const callback = page.waitForResponse((r) => r.url().includes('/api/auth/callback/'), {
				timeout: 60_000
			});
			const button = page.getByRole('button', { name: `Continue with ${google.name}` });
			await expect(async () => {
				await Promise.all([
					page.waitForRequest((r) => r.url().endsWith('/api/auth/sign-in/social'), {
						timeout: 5_000
					}),
					button.click({ timeout: 5_000 })
				]);
			}).toPass({ timeout: 75_000 });
			await callback;
			await page.waitForURL(
				(url) => url.origin === new URL(baseURL!).origin && !url.pathname.includes('/callback/'),
				{ timeout: 30_000 }
			);
			expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();
		};

		try {
			await signInWithGoogle();
			const first = await sessionUser();
			expect(first?.email).toBe(before);

			// The person changes the address at Google, then signs in again.
			providerEmail = after;
			await context.clearCookies();
			await signInWithGoogle();
			const second = await sessionUser();
			expect(second?.id, 'the second Google sign-in reached a different account').toBe(first?.id);
			expect(second?.email, 'the account kept the email from its first sign-in').toBe(after);

			// The Account page shows the new address, so the person can see which one we hold. The
			// sign-in landing can still be redirecting, which aborts a goto on it, so open a fresh page.
			await freshPage();
			await page.goto('/chat/settings/account', { waitUntil: 'load' });
			await expect(page.getByText(`Signed in as ${after}`)).toBeVisible({ timeout: 30_000 });

			// An email code at the new address opens the same account, not a second one.
			await context.clearCookies();
			await freshPage();
			await signInWithEmailOtp(page, DATABASE_URL!, after, { skipPendingLabelCheck: true });
			const third = await sessionUser();
			expect(third?.id, 'an email code at the new address opened a second account').toBe(first?.id);
		} finally {
			await deleteTestUsers([before, after]);
		}
	}
);

// Signing in brings a person back to the conversation they were in, with no new-chat
// landing in between (CUR-1677). sign-in.spec.ts and passkey-sign-in.spec.ts prove it for the email code and the
// passkey, which return through afterSignIn(); an OAuth sign-in returns through Better Auth's callback
// instead, redirecting to the `callbackURL` the login page passed (login/+page.svelte), so it needs its
// own walk. The guest's answer comes from upstream-stub.mjs, the leg's stand-in model.
for (const provider of PROVIDERS) {
	test(
		`signing in with ${provider.name} from a guest conversation lands back on it, with no new-chat landing on the way`,
		{ tag: ['@A1', '@local-mock'] },
		async ({ page, context, baseURL }) => {
			test.setTimeout(150_000);
			// The rail offers "Log in" only when accounts are on. This leg has no PostHog, so the flag is
			// set here, as mock-oidc-sign-in.spec.ts does for the Account page (CUR-2663).
			await setFlagOverrides(context, baseURL!, { accounts: true });
			await page.route(
				(url) => `${url.origin}${url.pathname}` === provider.authorize,
				async (route) => {
					const { search } = new URL(route.request().url());
					await route.fulfill({
						status: 302,
						headers: { location: `${MOCK_ORIGIN}/authorize${search}` }
					});
				}
			);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});

			const question = `Name one city in Portugal in one short sentence (${provider.name}).`;
			await page.goto(chatEntry(), { waitUntil: 'load' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationUrl = page.url();
			await expect(
				turnDone(page.locator('[data-message-role="assistant"]').last()),
				"the stub model's answer never finished, so there was no conversation for sign-in to carry; read upstream-stub.log"
			).toBeVisible({ timeout: 60_000 });

			const landingSightings = await watchForChatLanding(page);

			// Through the rail's "Log in", which carries this conversation as `next`.
			await (await accountMenuItem(page, 'Log in', { timeout: 20_000 })).click();
			await expect(page).toHaveURL(/\/chat\/login/, { timeout: 15_000 });
			const callback = page.waitForResponse((r) => r.url().includes('/api/auth/callback/'), {
				timeout: 60_000
			});
			const button = page.getByRole('button', { name: `Continue with ${provider.name}` });
			await expect(async () => {
				await Promise.all([
					page.waitForRequest((r) => r.url().endsWith('/api/auth/sign-in/social'), {
						timeout: 5_000
					}),
					button.click({ timeout: 5_000 })
				]);
			}).toPass({ timeout: 45_000 });
			await callback;

			await expect(
				page,
				`${provider.name} sign-in did not return to the conversation it started from`
			).toHaveURL(conversationUrl, { timeout: 30_000 });
			await expect(page.getByText(question)).toBeVisible({ timeout: 15_000 });
			const res = await page.request.get('/chat/api/auth/get-session');
			const session = (await res.json()) as { user?: { email?: string } } | null;
			expect(session?.user?.email).toBe(provider.email);
			expect(
				landingSightings,
				`after the ${provider.name} callback, the new-chat landing rendered before this conversation came back`
			).toEqual([]);
		}
	);
}

// The callback must belong to the browser that started the sign-in. Better Auth binds `state` to a
// signed cookie it sets on that browser, so a code and state carried into any other browser (a
// login-CSRF: someone hands you a link that signs you in as them) are refused. This starts the
// sign-in in one browser, gets the code from the mock, and delivers the callback to a second browser
// that never started anything.
for (const provider of PROVIDERS) {
	test(
		`a ${provider.name} callback opened in a browser that never started the sign-in is refused, and signs nobody in`,
		{ tag: '@local-mock' },
		async ({ page, browser, baseURL }) => {
			await page.goto('/chat/login', { waitUntil: 'load' });

			// Called from inside the page so Better Auth sets its state cookie on this browser.
			const start = await page.evaluate(async (id) => {
				const res = await fetch('/chat/api/auth/sign-in/social', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ provider: id, callbackURL: '/chat' })
				});
				return { status: res.status, body: (await res.json()) as { url?: string } };
			}, provider.id);
			expect(start.status, `sign-in/social answered ${JSON.stringify(start.body)}`).toBe(200);
			const { search } = new URL(start.body.url!);

			// The mock answers its authorize endpoint with a redirect to our callback, code and state on it.
			const authorized = await page.request.get(`${MOCK_ORIGIN}/authorize${search}`, {
				maxRedirects: 0
			});
			const callbackUrl = authorized.headers()['location'];
			expect(callbackUrl, 'the mock gave no callback redirect').toContain('/api/auth/callback/');

			const other = await browser.newContext({ baseURL });
			try {
				const otherPage = await other.newPage();
				await otherPage.goto(callbackUrl, { waitUntil: 'load' });
				expect(
					new URL(otherPage.url()).searchParams.get('error'),
					`landed on ${otherPage.url()}`
				).toBe('state_mismatch');
				const res = await otherPage.request.get('/chat/api/auth/get-session');
				const session = (await res.json()) as { user?: { email?: string } } | null;
				expect(session?.user?.email, 'the second browser was signed in').toBeUndefined();
			} finally {
				await other.close();
			}
		}
	);
}

// A person who backs out of the provider's consent screen (CUR-2793). The provider answers the
// authorize request by sending the browser straight back with `error=access_denied` and the same
// state, which is what Google does on Cancel. They land on sign-in, still signed out, with copy that
// says nothing changed. Before this the page showed "Linking failed (access_denied)".
test(
	"cancelling at the provider's consent screen lands back on sign-in, signed out, with copy that says nothing changed",
	{ tag: ['@A1', '@local-mock'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const google = PROVIDERS[0];
		await page.route(
			(url) => `${url.origin}${url.pathname}` === google.authorize,
			async (route) => {
				const asked = new URL(route.request().url());
				const back = new URL(asked.searchParams.get('redirect_uri')!);
				back.searchParams.set('error', 'access_denied');
				back.searchParams.set('state', asked.searchParams.get('state')!);
				await route.fulfill({ status: 302, headers: { location: back.toString() } });
			}
		);
		await page.goto('/chat/login', { waitUntil: 'load' });

		await journeyStep(page, 'A1', 17, async () => {
			const button = page.getByRole('button', { name: `Continue with ${google.name}` });
			await expect(async () => {
				await Promise.all([
					page.waitForRequest((r) => r.url().endsWith('/api/auth/sign-in/social'), {
						timeout: 5_000
					}),
					button.click({ timeout: 5_000 })
				]);
			}).toPass({ timeout: 75_000 });
			await page.waitForURL((url) => url.pathname.endsWith('/chat/login'), { timeout: 30_000 });
			const alert = page.getByRole('alert');
			await expect(alert).toHaveText(
				"You cancelled at the provider, so nothing changed. Try again when you're ready.",
				{ timeout: 15_000 }
			);
			await expect(
				alert,
				'the cancellation reads as a link failure or shows the raw code'
			).not.toContainText(/link|access_denied/i);
			const session = await page.evaluate(async () =>
				(await fetch('/chat/api/auth/get-session')).json()
			);
			expect(session?.user ?? null, 'a cancelled consent signed someone in').toBeNull();
		});
	}
);
