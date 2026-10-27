// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { sslFor } from './helpers/db';
import { journeyStep } from './helpers/journeyStep';
import { phrase } from './helpers/text';
import { startChattingPastWelcome } from './helpers/welcome';

// Walks a full OIDC sign-in, the same genericOAuth path Hugging Face uses, against the
// mock provider (mock-oidc/), so the redirect → consent → callback → session chain gets exercised
// without a real HF account.
//
// @local-mock: the mock runs inside the test run, on localhost beside the app and its database, never
// on a public host (CUR-2451). sign-in-local.yml starts all three from the checked-out tree and sets
// SCENARIO_LOCAL_MOCK=1; playwright.config.ts leaves the tag out of every other run. The mock's
// address comes from MOCK_OIDC_PROVIDER_URL, the same variable the app registers it from.
//
// The mock issues one fixed identity (mock-oidc/server.mjs), so this asserts that exact email came
// back in the session. A session belonging to anyone else means the chain is wired wrong.
const MOCK_IDENTITY_EMAIL = 'mock-oidc-e2e@example.org';
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const MOCK_ORIGIN = (process.env.MOCK_OIDC_PROVIDER_URL ?? '').replace(/\/+$/, '');

// That one identity is also one provider account row, and an account row belongs to one user. The
// link test below has to take it from whichever user the sign-in walk left holding it, and then give
// it back, so the two run in order in one worker instead of racing for it.
test.describe.configure({ mode: 'serial' });

/** Deletes test users by email; session and account rows cascade. Test identities only. */
async function deleteTestUsers(emails: string[]): Promise<void> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		await sql`delete from "user" where email in ${sql(emails)}`;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

test(
	'a person can sign in through an OIDC provider end to end, and the session carries the identity it issued',
	{ tag: '@local-mock' },
	async ({ page, baseURL }) => {
		await page.goto('/chat/login', { waitUntil: 'load' });
		await expect(page).toHaveURL(/\/chat\/login/);

		// Called from inside the page so the browser sends its own Origin and keeps the state cookie
		// Better Auth sets here, which the callback checks against the `state` it gets back.
		const start = await page.evaluate(async () => {
			const res = await fetch('/chat/api/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: 'mock-oidc', callbackURL: '/chat' })
			});
			return { status: res.status, body: (await res.json()) as { url?: string; code?: string } };
		});
		expect(start.status, `sign-in/social answered ${JSON.stringify(start.body)}`).toBe(200);
		expect(start.body.url?.startsWith(`${MOCK_ORIGIN}/authorize?`), start.body.url).toBe(true);

		// The mock's authorize endpoint redirects straight back with a code; the callback exchanges it
		// at the mock's token endpoint (which refuses any client but ours) and sets the session.
		await page.goto(start.body.url!, { waitUntil: 'commit' });
		await page.waitForURL(
			(url) => url.origin === new URL(baseURL!).origin && !url.pathname.includes('/callback/'),
			{
				timeout: 30_000
			}
		);
		expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();

		const session = await page.evaluate(async () => {
			const res = await fetch('/chat/api/auth/get-session');
			return (await res.json()) as { user?: { email?: string } } | null;
		});
		expect(session?.user?.email).toBe(MOCK_IDENTITY_EMAIL);
	}
);

// A1 step 9, the half left open by CUR-2362: the account_not_linked warning (sign-in.spec.ts) sends a
// person to Settings → Account to add their second provider, and this walks that link to the end.
// It drives the same `/link-social` call the page's Link button makes, aimed at the mock provider
// because the button's real providers send the browser to Google, GitHub or Hugging Face, where CI
// has no account. Better Auth registers generic OAuth providers alongside the social ones, so the
// mock goes through the same link callback a real provider would.
test(
	'a person who links a second sign-in provider from Settings → Account comes back to see it listed there',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page, context, baseURL }) => {
		const email = freshTestEmail();
		// `accounts` is on in develop and production. This leg has no PostHog, so without the override
		// loginEnabled() falls back to OPENID_CLIENT_ID, which it doesn't set, and the settings nav
		// drew a signed-in person as signed out: no Account entry beside the Account page (CUR-2663).
		await setFlagOverrides(context, baseURL!, { accounts: true });
		// The walk above signs in as the mock identity, which leaves its account row on that user.
		await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		try {
			await signInWithEmailOtp(page, DATABASE_URL!, email);
			await journeyStep(page, 'A1', 9, async () => {
				await page.goto('/chat/settings/account', { waitUntil: 'load' });
				await expect(page.getByText('Linked providers')).toBeVisible({ timeout: 15_000 });
				await expect(
					page.getByRole('link', { name: 'Account', exact: true }),
					'the settings nav should list Account while the Account page is open'
				).toBeVisible();

				const start = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/link-social', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							provider: 'mock-oidc',
							callbackURL: '/chat/settings/account',
							errorCallbackURL: '/chat/settings/account'
						})
					});
					return { status: res.status, body: (await res.json()) as { url?: string } };
				});
				expect(start.status, `link-social answered ${JSON.stringify(start.body)}`).toBe(200);
				expect(start.body.url?.startsWith(`${MOCK_ORIGIN}/authorize?`), start.body.url).toBe(true);

				await page.goto(start.body.url!, { waitUntil: 'commit' });
				await page.waitForURL((url) => url.pathname === '/chat/settings/account', {
					timeout: 30_000
				});
				expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();

				// Still the same person: linking adds a way in, it does not swap the account.
				const session = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/get-session');
					return (await res.json()) as { user?: { email?: string } } | null;
				});
				expect(session?.user?.email).toBe(email);

				const linkedRow = page
					.locator('div')
					.filter({ has: page.getByText('mock-oidc', { exact: true }) })
					.filter({ has: page.locator(':scope > button', { hasText: 'Unlink' }) });
				await expect(
					linkedRow,
					'the provider just linked should be listed under Linked providers, with a way to unlink it'
				).toBeVisible({ timeout: 15_000 });
				await holdForRecording(page);
			});
		} finally {
			// Frees the mock identity's account row for the next walk.
			await deleteTestUsers([email]);
		}
	}
);

/** The signed-in user's id and email, read from the server rather than the page. */
async function currentUser(page: Page): Promise<{ id?: string; email?: string } | undefined> {
	const res = await page.request.get('/chat/api/auth/get-session');
	const session = (await res.json()) as { user?: { id?: string; email?: string } } | null;
	return session?.user;
}

/** Signs out through the rail and waits until the server agrees nobody is signed in. */
async function logOut(page: Page): Promise<void> {
	await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
	await expect(accountButton(page)).toHaveAccessibleName('Account — guest', { timeout: 15_000 });
	await expect.poll(async () => (await currentUser(page))?.id ?? null).toBeNull();
}

/** Signs in through the mock provider from the sign-in page and returns the user it reached. */
async function signInThroughMock(
	page: Page,
	baseURL: string
): Promise<{ id?: string; email?: string } | undefined> {
	await page.goto('/chat/login', { waitUntil: 'load' });
	const start = await page.evaluate(async () => {
		const res = await fetch('/chat/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'mock-oidc', callbackURL: '/chat' })
		});
		return { status: res.status, body: (await res.json()) as { url?: string } };
	});
	expect(start.status, `sign-in/social answered ${JSON.stringify(start.body)}`).toBe(200);
	await page.goto(start.body.url!, { waitUntil: 'commit' });
	await page.waitForURL(
		(url) => url.origin === new URL(baseURL).origin && !url.pathname.includes('/callback/'),
		{ timeout: 30_000 }
	);
	expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();
	return currentUser(page);
}

// A1 step 9's other half (CUR-2721). Linking a provider only matters if the person can come back
// through it. The server side resolves the linked provider to the same user (CUR-1166,
// betterAuth.accountMerge.spec.ts); this walks it in a browser with a conversation in the account, and
// checks that the person sees that chat again as well as getting the same user id. The mock's single
// identity has a different email from the account's, so a sign-in that made a new user would carry
// the mock's email and an empty history.
test(
	'after linking a second provider and signing out, signing in through that provider brings back the same account and its conversation',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const email = freshTestEmail();
		const question = 'Name one river in Portugal in one short sentence.';
		await setFlagOverrides(context, baseURL!, { accounts: true });
		await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		try {
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			const original = await currentUser(page);
			expect(original?.email).toBe(email);

			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationPath = new URL(page.url()).pathname;
			await expect(
				turnDone(page.locator('[data-message-role="assistant"]').last()),
				"the stub model's answer never finished; read upstream-stub.log"
			).toBeVisible({ timeout: 60_000 });

			// The same call the Account page's Link button makes, aimed at the mock (see the test above).
			await page.goto('/chat/settings/account', { waitUntil: 'load' });
			await expect(page.getByText('Linked providers')).toBeVisible({ timeout: 15_000 });
			const link = await page.evaluate(async () => {
				const res = await fetch('/chat/api/auth/link-social', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						provider: 'mock-oidc',
						callbackURL: '/chat/settings/account',
						errorCallbackURL: '/chat/settings/account'
					})
				});
				return { status: res.status, body: (await res.json()) as { url?: string } };
			});
			expect(link.status, `link-social answered ${JSON.stringify(link.body)}`).toBe(200);
			await page.goto(link.body.url!, { waitUntil: 'commit' });
			await page.waitForURL((url) => url.pathname === '/chat/settings/account', {
				timeout: 30_000
			});
			expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();

			await page.goto(chatEntry(), { waitUntil: 'load' });
			await logOut(page);

			// Back in through the linked provider, from the sign-in page.
			await page.goto('/chat/login', { waitUntil: 'load' });
			const start = await page.evaluate(async () => {
				const res = await fetch('/chat/api/auth/sign-in/social', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ provider: 'mock-oidc', callbackURL: '/chat' })
				});
				return { status: res.status, body: (await res.json()) as { url?: string } };
			});
			expect(start.status, `sign-in/social answered ${JSON.stringify(start.body)}`).toBe(200);
			await page.goto(start.body.url!, { waitUntil: 'commit' });
			await page.waitForURL(
				(url) => url.origin === new URL(baseURL!).origin && !url.pathname.includes('/callback/'),
				{ timeout: 30_000 }
			);
			expect(new URL(page.url()).searchParams.get('error'), `landed on ${page.url()}`).toBeNull();

			expect(
				await currentUser(page),
				'signing in through the linked provider reached a different account from the one it was linked to'
			).toEqual(expect.objectContaining({ id: original?.id, email }));
			await expect(
				page.locator(`a[href$="${conversationPath}"]`).first(),
				'the conversation from before signing out is not listed after signing in through the linked provider'
			).toBeAttached({ timeout: 15_000 });
			await page.goto(conversationPath, { waitUntil: 'load' });
			await expect(page.getByText(question).first()).toBeVisible({ timeout: 15_000 });
			await holdForRecording(page);

			// And the original way in still reaches the same account.
			await logOut(page);
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			expect(
				(await currentUser(page))?.id,
				'signing in by email code after linking reached a different account'
			).toBe(original?.id);
		} finally {
			await deleteTestUsers([email, MOCK_IDENTITY_EMAIL]);
		}
	}
);

// A1 step 12 (CUR-2794). Someone whose only way in is one provider must not be able to unlink it, or
// they lock themselves out. The page disables the button, but the guard that matters is the server's:
// better-auth refuses the last account unless `allowUnlinkingAll` is set, and our config leaves it
// unset (betterAuth.ts, `accountLinking`). This calls `/unlink-account` directly, the way the page's
// button would if it were enabled, so a config change or a better-auth bump that drops the refusal
// goes red here. A person who signed in through the mock alone has exactly one account row.
test(
	'a person whose only way in is one provider cannot unlink it, from the page or by calling the server',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { accounts: true });
		await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		// The welcome covers the whole app, rail included, so the sign-out at the end can't reach the
		// account menu until it's closed.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		try {
			const user = await signInThroughMock(page, baseURL!);
			expect(user?.email).toBe(MOCK_IDENTITY_EMAIL);

			await journeyStep(page, 'A1', 12, async () => {
				await page.goto('/chat/settings/account', { waitUntil: 'load' });
				await expect(page.getByText('Linked providers')).toBeVisible({ timeout: 15_000 });
				const onlyRow = page
					.locator('div')
					.filter({ has: page.getByText('mock-oidc', { exact: true }) })
					.filter({ has: page.locator(':scope > button', { hasText: 'Unlink' }) });
				const unlink = onlyRow.locator(':scope > button', { hasText: 'Unlink' });
				await expect(
					unlink,
					'the only linked provider should offer no way to unlink it'
				).toBeDisabled({
					timeout: 15_000
				});
				await expect(unlink).toHaveAttribute(
					'title',
					'Link another provider before unlinking this one'
				);
				// A tooltip on a disabled button never shows on touch, often not on hover either, and never in
				// a recording, so the reason has to be on the page (CUR-2899). It names the real rule, the last
				// provider, and never says the person would have no way in: the email-code row above it says it
				// can always sign in (CUR-3144).
				await expect(
					onlyRow.getByText(
						'This is the only provider linked, so link another before unlinking it. Your email code still works either way.'
					),
					'the page does not say why Unlink is off; only a tooltip does'
				).toBeVisible();
				await expect(page.getByTestId('sign-in-method-email')).toBeVisible();
				await expect(
					page.getByText(/at least one way to sign in/),
					'the provider row says the person needs a way in, under an email code that is one'
				).toHaveCount(0);
				await holdForRecording(page);

				const attempt = await page.evaluate(async () => {
					const listed = await fetch('/chat/api/auth/list-accounts');
					const accounts = (await listed.json()) as { id: string; providerId: string }[];
					const res = await fetch('/chat/api/auth/unlink-account', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ accountId: accounts[0]?.id })
					});
					return { accounts, status: res.status, body: (await res.json()) as { code?: string } };
				});
				expect(
					attempt.accounts.map((a) => a.providerId),
					'a person signed in through the mock alone should have that one account and no other'
				).toEqual(['mock-oidc']);
				expect(
					attempt.status,
					`the server let the last sign-in method go: ${JSON.stringify(attempt.body)}`
				).toBe(400);
				expect(attempt.body.code).toBe('FAILED_TO_UNLINK_LAST_ACCOUNT');

				const after = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/list-accounts');
					return ((await res.json()) as { providerId: string }[]).map((a) => a.providerId);
				});
				expect(after, 'the refused unlink still removed the account').toEqual(['mock-oidc']);
				await page.reload({ waitUntil: 'load' });
				await expect(
					unlink,
					'after the refused call, the provider is gone from the page'
				).toBeVisible({
					timeout: 15_000
				});
				await captionForRecording(
					page,
					'asked the server directly to unlink it: refused, and the provider is still listed'
				);
				await holdForRecording(page);
			});

			// And the way in still works: out, then back through the same provider to the same user.
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await logOut(page);
			expect(
				(await signInThroughMock(page, baseURL!))?.id,
				'signing back in reached a different user'
			).toBe(user?.id);
		} finally {
			await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		}
	}
);

// A1 step 13 (CUR-2792). One provider account signs in one person. If linking could move it, whoever
// linked it first would take over someone else's sign-in. Better Auth's link callback refuses a
// provider account that already belongs to another user (callback.mjs, before any write) with
// `account_already_linked_to_different_user`, and the account page shows that code's copy. Here the
// mock's one identity is the provider account: person A signs in through it, then person B, signed
// in by email code, tries to link it from Settings → Account.
test(
	'linking a provider account that already belongs to another account is refused, and both accounts keep their own ways in',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const email = freshTestEmail();
		await setFlagOverrides(context, baseURL!, { accounts: true });
		await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		try {
			const owner = await signInThroughMock(page, baseURL!);
			expect(owner?.email).toBe(MOCK_IDENTITY_EMAIL);
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await logOut(page);

			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			const other = await currentUser(page);
			expect(other?.email).toBe(email);

			await journeyStep(page, 'A1', 13, async () => {
				await page.goto('/chat/settings/account', { waitUntil: 'load' });
				await expect(page.getByText('Linked providers')).toBeVisible({ timeout: 15_000 });
				// The same call the Account page's Link button makes, aimed at the mock (see step 9 above).
				const link = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/link-social', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							provider: 'mock-oidc',
							callbackURL: '/chat/settings/account',
							errorCallbackURL: '/chat/settings/account'
						})
					});
					return { status: res.status, body: (await res.json()) as { url?: string } };
				});
				expect(link.status, `link-social answered ${JSON.stringify(link.body)}`).toBe(200);
				await page.goto(link.body.url!, { waitUntil: 'commit' });
				await page.waitForURL((url) => url.pathname === '/chat/settings/account', {
					timeout: 30_000
				});
				await expect(
					page.getByText('That provider account is already linked to a different account.'),
					'linking a provider account another person signs in with should be refused on the page'
				).toBeVisible({ timeout: 15_000 });
				await holdForRecording(page);

				expect(await currentUser(page), 'the refused link changed who is signed in').toEqual(
					expect.objectContaining({ id: other?.id, email })
				);
				const providers = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/list-accounts');
					return ((await res.json()) as { providerId: string }[]).map((a) => a.providerId);
				});
				expect(
					providers,
					'the refused link still added the provider to this account'
				).not.toContain('mock-oidc');
			});

			// The provider still signs its owner in, to the owner's account.
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await logOut(page);
			expect(
				(await signInThroughMock(page, baseURL!))?.id,
				"the provider account no longer reaches its owner's account"
			).toBe(owner?.id);
		} finally {
			await deleteTestUsers([email, MOCK_IDENTITY_EMAIL]);
		}
	}
);

/** Rows the database holds for an email: its users, and the provider accounts those users have. */
async function rowsForEmail(email: string): Promise<{ users: number; providers: string[] }> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const users = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
		const accounts = users.length
			? await sql<{ provider_id: string }[]>`
					select provider_id from account where user_id in ${sql(users.map((u) => u.id))}
				`
			: [];
		return { users: users.length, providers: accounts.map((a) => a.provider_id).sort() };
	} finally {
		await sql.end({ timeout: 5 });
	}
}

// A1 step 9 (CUR-2790). Someone who first signed in by email code comes back through a provider that
// reports the same email. Implicit linking is off (betterAuth.ts, `disableImplicitLinking`), so the
// callback refuses with `account_not_linked`, lands back on the sign-in page, and shows the warning.
// sign-in.spec.ts renders that warning from the URL alone; this drives the refusal that produces it,
// and checks nothing was written: still one user for the email, still without the provider's account.
test(
	'signing in through a provider on an email that already has an account is refused with the warning, and makes no second account',
	{ tag: ['@A1', '@local-mock'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { accounts: true });
		await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		try {
			await signInWithEmailOtp(page, DATABASE_URL!, MOCK_IDENTITY_EMAIL, {
				skipPendingLabelCheck: true
			});
			const original = await currentUser(page);
			expect(original?.email).toBe(MOCK_IDENTITY_EMAIL);
			expect(await rowsForEmail(MOCK_IDENTITY_EMAIL)).toEqual({
				users: 1,
				providers: expect.not.arrayContaining(['mock-oidc'])
			});
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await logOut(page);

			await journeyStep(page, 'A1', 9, async () => {
				await page.goto('/chat/login', { waitUntil: 'load' });
				// The body the sign-in page's provider buttons send (login/+page.svelte, signInSocial).
				const start = await page.evaluate(async () => {
					const res = await fetch('/chat/api/auth/sign-in/social', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							provider: 'mock-oidc',
							callbackURL: '/chat/',
							errorCallbackURL: '/chat/login'
						})
					});
					return { status: res.status, body: (await res.json()) as { url?: string } };
				});
				expect(start.status, `sign-in/social answered ${JSON.stringify(start.body)}`).toBe(200);

				// The refusal comes back as a navigation to the error page with the code in the query, which
				// the sign-in page then strips (login/+page.svelte onMount), so it is caught on commit.
				await page.goto(start.body.url!, { waitUntil: 'commit' });
				await page.waitForURL(
					(url) =>
						url.origin === new URL(baseURL!).origin &&
						url.pathname === '/chat/login' &&
						url.searchParams.get('error') === 'account_not_linked',
					{ timeout: 30_000, waitUntil: 'commit' }
				);
				await expect(
					page.getByText(
						phrase(
							'An account with this email already exists. Sign in the way you originally did, then add this as another way in from Settings → Account.'
						)
					)
				).toBeVisible({ timeout: 15_000 });
				await holdForRecording(page);
			});

			expect(
				(await currentUser(page))?.id ?? null,
				'the refused sign-in still signed the person in'
			).toBeNull();
			expect(
				await rowsForEmail(MOCK_IDENTITY_EMAIL),
				'the refused sign-in made a second account or linked the provider anyway'
			).toEqual({ users: 1, providers: expect.not.arrayContaining(['mock-oidc']) });
		} finally {
			await deleteTestUsers([MOCK_IDENTITY_EMAIL]);
		}
	}
);
