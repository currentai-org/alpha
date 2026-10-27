// e2e-product: @chat
// e2e-area: @models @settings
// Pairing a device from aipotluck-local-client in one click. The CLI makes up a pairing id,
// opens /chat/local-inference/pair?id=…&name=… in the browser, and polls
// /chat/api/v2/local-inference/pairings/<id>. This spec plays the CLI: it opens the link the way a
// terminal does (a navigation no page started), and polls the route with no cookies.
//
// Pangolin answers from the in-process stub (`pangolin_stub`, managedInference/e2eStub.ts): previews
// have no Pangolin, and the stub runs the same provisioning code with only the network call skipped.
// Preview-only: production refuses both the fault and the flag override.
import { randomBytes } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from './helpers/test';
import { faultInjectionHeaders } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { freshTestEmail } from './helpers/signIn';
import { testAuthHelpers } from '../testAuth';

const FLAGS = { 'local-inference': true, 'local-inference-managed': true };

function newPairingId(): string {
	return randomBytes(24).toString('base64url');
}

function pairPath(pairingId: string, name: string): string {
	return `/chat/local-inference/pair?id=${pairingId}&name=${encodeURIComponent(name)}`;
}

/** The fault rides the pairing page's own requests: the document, SvelteKit's __data.json and the
 *  confirm form's POST. */
async function stubPangolinOnPairPage(page: Page): Promise<void> {
	const headers = faultInjectionHeaders('pangolin_stub');
	await page.route(
		(url) => /\/local-inference\/pair(\/__data\.json)?$/.test(url.pathname),
		(route) => route.continue({ headers: { ...route.request().headers(), ...headers } })
	);
}

/** A session for a fresh account, handed to the browser without navigating, so the page already open
 *  (sign-in, here) decides where the visitor goes next. */
async function mintSession(page: Page): Promise<void> {
	const auth = await testAuthHelpers();
	const user = auth.createUser({ email: freshTestEmail() });
	user.name = '';
	await auth.saveUser(user);
	await page.context().addCookies(await auth.getCookies({ userId: user.id }));
}

/** One poll, as the CLI makes it: no cookies, no session. */
async function poll(
	request: APIRequestContext,
	pairingId: string
): Promise<Record<string, unknown>> {
	const res = await request.get(`/chat/api/v2/local-inference/pairings/${pairingId}`, {
		headers: { cookie: '' }
	});
	expect(res.status(), 'the poll answers 200 whether or not the pairing is ready').toBe(200);
	expect(res.headers()['cache-control']).toBe('no-store');
	return (await res.json()) as Record<string, unknown>;
}

test.describe('CLI pairing link', () => {
	test.beforeEach(async ({ page, baseURL }) => {
		await setFlagOverrides(page.context(), baseURL!, FLAGS);
		await stubPangolinOnPairPage(page);
	});

	test(
		'a signed-out person opening the CLI link signs in, lands back on it, and the device pairs: the poll gets its install flags once and Settings lists it',
		{ tag: ['@preview-only', '@CUR-4110'] },
		async ({ page, request }) => {
			const pairingId = newPairingId();
			const name = `Desk ${Date.now().toString(36)}`;

			await page.goto(pairPath(pairingId, name));
			await expect(page, 'signed out, the link goes to sign-in').toHaveURL(/\/chat\/login\?next=/, {
				timeout: 30_000
			});
			const next = new URL(page.url()).searchParams.get('next');
			expect(next, 'sign-in comes back to the whole link, id and name included').toBe(
				pairPath(pairingId, name)
			);
			expect(await poll(request, pairingId), 'nothing to collect before the visit').toEqual({});

			// Sign-in itself is covered by sign-in.spec.ts. Signed in, the sign-in page sends the visitor
			// on to `next`, back to the link. Read without following: Playwright does not route a
			// redirected request, so a followed redirect would reach the pairing page without the stub's
			// header and provision against a real Pangolin wherever one is configured.
			await mintSession(page);
			const back = await page.request.get(page.url(), { maxRedirects: 0 });
			expect(back.status()).toBe(302);
			expect(back.headers()['location']).toBe(pairPath(pairingId, name));
			await page.goto(pairPath(pairingId, name));

			await expect(
				page.getByRole('heading', { name: 'Pairing completed, you can close this window' })
			).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText(`${name} is now one of your servers.`)).toBeVisible();

			const collected = await poll(request, pairingId);
			expect(collected).toMatchObject({
				id: expect.any(String),
				label: name,
				installArgs: {
					tunnelId: expect.stringMatching(/^stub-newt-/),
					tunnelSecret: expect.stringMatching(/^stub-secret-/),
					tunnelEndpoint: expect.stringContaining('pangolin-stub.e2e.invalid')
				}
			});
			expect(await poll(request, pairingId), 'the install flags are handed out once').toEqual({});

			// Opening the same link again is not a second device. (Opened, not reloaded: Chrome may send a
			// reload as same-origin, which correctly gets the confirm step instead.)
			await page.goto(pairPath(pairingId, name));
			await expect(
				page.getByRole('heading', { name: 'Pairing completed, you can close this window' })
			).toBeVisible({ timeout: 30_000 });

			await page.getByRole('link', { name: 'Open Local inference settings' }).click();
			await expect(page).toHaveURL(/\/chat\/settings\/local-inference$/);
			await expect(page.getByText(name, { exact: true })).toHaveCount(1, { timeout: 30_000 });

			// A reload the page itself starts (location.reload, as a dev server's or an app's own refresh
			// does) arrives same-origin, and a finished pairing must still read as finished, not as a
			// confirm button.
			await page.goBack();
			await expect(page).toHaveURL(/\/chat\/local-inference\/pair\?/);
			await page.evaluate(() => location.reload());
			await expect(
				page.getByRole('heading', { name: 'Pairing completed, you can close this window' })
			).toBeVisible({ timeout: 30_000 });
			await expect(page.getByRole('button', { name: 'Pair device' })).toHaveCount(0);
		}
	);

	test(
		'a link reached from another web page pairs nothing until the person confirms the device by name',
		{ tag: ['@preview-only', '@CUR-4110'] },
		async ({ page, request, baseURL }) => {
			await signInAsFreshUser(page);
			const pairingId = newPairingId();
			const name = `Laptop ${Date.now().toString(36)}`;

			// A page on another site linking to the pairing URL: the navigation is cross-site.
			const elsewhere = 'https://elsewhere.e2e.invalid/';
			await page.route(elsewhere, (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: `<a href="${new URL(pairPath(pairingId, name), baseURL).href}">pair</a>`
				})
			);
			await page.goto(elsewhere);
			await page.getByRole('link', { name: 'pair' }).click();

			await expect(
				page.getByRole('heading', { name: `Pair ${name} with your account?` })
			).toBeVisible({ timeout: 30_000 });
			expect(await poll(request, pairingId), 'a cross-site arrival provisions nothing').toEqual({});

			await page.getByRole('button', { name: 'Pair device' }).click();
			await expect(
				page.getByRole('heading', { name: 'Pairing completed, you can close this window' })
			).toBeVisible({ timeout: 30_000 });
			expect(await poll(request, pairingId)).toMatchObject({ label: name });
		}
	);
});
