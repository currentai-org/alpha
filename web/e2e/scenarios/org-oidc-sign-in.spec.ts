// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import postgres from 'postgres';
import { sslFor } from './helpers/db';

// a self-hosted Alpha lets its organisation's people sign in with the organisation's own
// OIDC login, configured from env alone. sign-in-local.sh sets OIDC_ISSUER, OIDC_CLIENT_ID,
// OIDC_CLIENT_SECRET and OIDC_PROVIDER_NAME="Example Org" against the mock provider, which this
// provider discovers like any issuer (/.well-known/openid-configuration, JWKS-verified ID token).
// SIGN_IN_LOCAL_ORG_ENV=open-webui sets Open WebUI's names (OPENID_PROVIDER_URL, OAUTH_CLIENT_ID,
// OAUTH_CLIENT_SECRET, OAUTH_PROVIDER_NAME) for the same provider instead, and this spec is unchanged.
//
// @local-mock: the mock runs beside the app on localhost, never on a public host.
//
// The mock answers the organisation's client with one fixed identity of its own
// (mock-oidc/server.mjs ORG_IDENTITY), so a session for that address proves the button reached the
// organisation provider and not the mock-oidc one, which signs in as a different address.
const ORG_NAME = 'Example Org';
const ORG_IDENTITY_EMAIL = 'mock-org-e2e@example.org';
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

async function deleteOrgUser(): Promise<void> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		await sql`delete from "user" where email = ${ORG_IDENTITY_EMAIL}`;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

test(
	"a person signs in with their organisation's own OIDC login, offered under the name the operator set",
	{ tag: '@local-mock' },
	async ({ page, baseURL }) => {
		await deleteOrgUser();
		await page.goto('/chat/login', { waitUntil: 'load' });
		const button = page.getByRole('button', { name: `Continue with ${ORG_NAME}` });
		await expect(
			button,
			'the sign-in page should offer the organisation login by its name'
		).toBeVisible({
			timeout: 15_000
		});
		await expect(button).toHaveText(ORG_NAME);

		const callback = page.waitForResponse((r) => r.url().includes('/api/auth/callback/org-oidc'), {
			timeout: 60_000
		});
		// A click before hydration does nothing, so keep clicking until the sign-in request leaves.
		test.setTimeout(150_000);
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

		const res = await page.request.get('/chat/api/auth/get-session');
		expect(res.status(), `get-session answered ${await res.text()}`).toBe(200);
		const session = (await res.json()) as { user?: { email?: string } } | null;
		expect(session?.user?.email).toBe(ORG_IDENTITY_EMAIL);
	}
);
