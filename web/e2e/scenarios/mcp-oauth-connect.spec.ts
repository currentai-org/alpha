// e2e-product: @chat
// e2e-area: @agent @settings
//
// A signed-in person adds an MCP server of their own that signs them in with OAuth, from Settings →
// Connectors: the add form sends them to its sign-in, they come back connected and see its tool. Then
// the provider's access token expires: the server answers 401, the app refreshes, the server stays
// connected, and a fresh page load shows the app reaching it with the refreshed token it stored. Last,
// they take the app off their account at the provider, and the page offers Reconnect.
//
// The server and its authorization server are answered inside the app under the `mcp_oauth_stub`
// faults (src/lib/chat/server/mcp/oauthE2eStub.ts); everything between them is the real code: the
// MCP SDK's discovery, client registration, PKCE and code exchange, the sealed state cookie and the
// sealed sign-in on the row, the MCP client listing the tool with the access token, and the one
// refresh after the server's 401, written back to the row. The stand-in's tool description names the
// issue time of the access token the server was reached with, which is how the spec sees which sign-in
// the app sent. Only the provider's consent screen is answered here, by sending the
// person back to the callback with the code, as the provider does after they allow it.
//
// Runs in mock-model-e2e.sh only, which hands this spec its fault token as MOCK_E2E_FAULT_TOKEN.
// @mock-only keeps every other run, which has no fault token for it, from collecting it.
import { test, expect, type Page } from './helpers/test';
import { chatPath } from './helpers/chatEntry';
import { faultInjectionHeaders, type FaultInjectionName } from './helpers/faultInjection';
import { signInAsFreshUser } from './helpers/session';

/** oauthE2eStub.ts's stand-ins: the server's URL and the host its consent screen is on. */
const SERVER_URL = 'https://mcp-oauth.e2e.invalid/mcp';
const CONSENT_HOST = 'https://mcp-oauth.e2e.invalid';
const SERVER_NAME = 'notes';

/**
 * The provider as it is now: signed in, with short-lived access tokens, or after the person took the
 * app off their account there.
 */
let fault: FaultInjectionName = 'mcp_oauth_stub';
const faultHeaders = () => faultInjectionHeaders(fault, process.env.MOCK_E2E_FAULT_TOKEN);

/** Sends the current fault's headers on this app's requests whose path `matches`, and on no other. */
async function stubOn(page: Page, matches: (pathname: string) => boolean): Promise<void> {
	const origin = new URL(process.env.SCENARIO_BASE_URL ?? 'http://localhost').origin;
	await page.route(
		(url) => url.origin === origin && matches(url.pathname),
		(route) => route.continue({ headers: { ...route.request().headers(), ...faultHeaders() } })
	);
}

test(
	'a person adds a server that signs them in, connects it, and is offered Reconnect once the provider signs them out',
	{ tag: ['@root', '@mock-model', '@mock-only'] },
	async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);

		// The page lists the servers and runs the add action; the callback trades the code for tokens.
		await stubOn(page, (p) => /\/settings\/connectors(\/__data\.json)?$/.test(p));
		await stubOn(page, (p) => p.endsWith('/api/connectors/mcp/callback'));

		// Playwright does not route the hop a redirect makes, so the connect's 303 to the consent screen
		// is caught here: the response is fetched without following it, its consent URL read, and the
		// state cookie it sets handed to the browser with no redirect. The spec then plays the provider
		// sending the person back, with the code the stand-in takes (its PKCE challenge).
		let back: URL | undefined;
		await page.route(
			(url) => /\/api\/connectors\/mcp\/[^/]+\/connect$/.test(url.pathname),
			async (route) => {
				const res = await route.fetch({
					headers: { ...route.request().headers(), ...faultHeaders() },
					maxRedirects: 0
				});
				const consent = new URL(res.headers()['location'] ?? 'about:blank');
				expect(
					consent.origin,
					`the connect did not send the person to the sign-in (${res.status()})`
				).toBe(CONSENT_HOST);
				expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
				const next = new URL(consent.searchParams.get('redirect_uri') ?? '');
				next.searchParams.set('code', consent.searchParams.get('code_challenge') ?? '');
				next.searchParams.set('state', consent.searchParams.get('state') ?? '');
				const headers = { ...res.headers() };
				delete headers['location'];
				await route.fulfill({ response: res, status: 200, headers, body: 'consent' });
				back = next;
			}
		);

		await page.goto(chatPath('/settings/connectors'), { waitUntil: 'load' });
		const form = page.getByTestId('connector-add-form');
		await expect(form, 'Settings → Connectors does not offer the add form').toBeVisible({
			timeout: 30_000
		});
		await form.getByLabel('Name').fill(SERVER_NAME);
		await form.getByLabel('Server URL').fill(SERVER_URL);
		await form.getByRole('button', { name: 'Add server' }).click();

		// Adding a tokenless server that signs you in goes straight on to its sign-in.
		await expect
			.poll(() => back?.href, {
				message: 'adding the server never reached its sign-in',
				timeout: 30_000
			})
			.toBeTruthy();
		// The connect's own navigation must have landed before the spec navigates to the callback, or
		// the one still committing aborts the other.
		await page.waitForURL((url) => /\/api\/connectors\/mcp\/[^/]+\/connect$/.test(url.pathname), {
			waitUntil: 'load'
		});
		await page.goto(back!.href, { waitUntil: 'load' });
		await expect(page, 'the callback did not come back to Connectors as connected').toHaveURL(
			/\/settings\/connectors\?mcp=connected/,
			{ timeout: 30_000 }
		);
		// The callback's redirect to Connectors was a hop the fault header did not ride: load the page
		// again through its route, so it lists the stand-in's tool.
		await page.reload({ waitUntil: 'load' });
		await expect(page.locator('[data-connector-mcp-note]')).toHaveText('Your server is connected.');
		const server = page.locator(`[data-connector="${SERVER_NAME}"]`);
		await expect(
			server.locator('[data-connector-status="connected"]'),
			'the server is not listed as connected, so the code exchange or the listing failed'
		).toContainText('Connected · 1 tool', { timeout: 30_000 });
		await expect(page.locator(`[data-connector-tool="${SERVER_NAME}__read_note"]`)).toBeVisible();
		await testInfo.attach('mcp-oauth-connected', {
			body: await server.screenshot(),
			contentType: 'image/png'
		});

		// The stand-in names, in the tool's description, when the access token it was reached with was
		// issued.
		const signedInAt = async (on: Page): Promise<string | undefined> => {
			const text = await on
				.locator(`[data-connector-tool="${SERVER_NAME}__read_note"]`)
				.innerText();
			return /Signed in at (\d+)/.exec(text)?.[1];
		};
		const firstSignIn = await signedInAt(page);
		expect(
			firstSignIn,
			'the listing does not name the sign-in the server was reached with'
		).toBeTruthy();

		// The provider's access tokens now last five seconds, and this one is older: the server answers
		// the next listing with a 401, the app refreshes once and repeats the request with the new token.
		// The wait is the token's age on the app's own clock, which is the stand-in's.
		await page.waitForTimeout(6_000);
		fault = 'mcp_oauth_stub_expiring';
		await page.goto(chatPath('/settings/connectors'), { waitUntil: 'load' });
		await expect(
			server.locator('[data-connector-status="connected"]'),
			'a server whose access token expired is not listed as connected, so the refresh after its 401 failed'
		).toContainText('Connected · 1 tool', { timeout: 30_000 });
		await expect(server.getByRole('link', { name: `Reconnect ${SERVER_NAME}` })).toHaveCount(0);
		const refreshedSignIn = await signedInAt(page);
		expect(
			Number(refreshedSignIn),
			'the server was not reached with a newer access token after its 401'
		).toBeGreaterThan(Number(firstSignIn));

		// A fresh page, with access tokens that no longer expire, so nothing refreshes: the server is
		// reached with whatever the row holds, which must be the refreshed token, not the first one.
		fault = 'mcp_oauth_stub';
		const fresh = await page.context().newPage();
		await stubOn(fresh, (p) => /\/settings\/connectors(\/__data\.json)?$/.test(p));
		await fresh.goto(chatPath('/settings/connectors'), { waitUntil: 'load' });
		await expect(
			fresh.locator(`[data-connector="${SERVER_NAME}"] [data-connector-status="connected"]`)
		).toContainText('Connected · 1 tool', { timeout: 30_000 });
		expect(
			await signedInAt(fresh),
			'a fresh page reached the server with the first access token, so the refreshed one was never stored'
		).toBe(refreshedSignIn);
		await fresh.close();

		// The person takes the app off their account at the provider. The next listing gets a 401, the one
		// refresh is refused, and the server is marked for reconnecting.
		fault = 'mcp_oauth_stub_signed_out';
		await page.goto(chatPath('/settings/connectors'), { waitUntil: 'load' });
		await expect(
			server.locator('[data-connector-status="reconnect"]'),
			'a server whose sign-in the provider stopped honouring is not offered Reconnect'
		).toHaveText('Signed out', { timeout: 30_000 });
		await expect(server.getByRole('link', { name: `Reconnect ${SERVER_NAME}` })).toBeVisible();
		await expect(page.locator(`[data-connector-tool="${SERVER_NAME}__read_note"]`)).toHaveCount(0);
		await testInfo.attach('mcp-oauth-reconnect', {
			body: await server.screenshot(),
			contentType: 'image/png'
		});
	}
);
