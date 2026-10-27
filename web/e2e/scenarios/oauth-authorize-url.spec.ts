// e2e-product: @chat
// e2e-area: @auth
import { test, expect, type Page } from './helpers/test';
import { journeyStep } from './helpers/journeyStep';
import { chatPath } from './helpers/chatEntry';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { recordMeasurement } from './helpers/measurement';

// Google, GitHub and Hugging Face sign-in (CUR-1552, CUR-2694) up to the provider's door. Each test clicks the
// provider's button on the sign-in screen, catches the browser's navigation to the provider and
// answers it with an empty 204, so no request ever reaches Google or GitHub, and checks the authorize URL the app built.
// The server-to-server half (code for token, then the user's profile) is not covered here; the
// mock-OIDC walk (mock-oidc-sign-in.spec.ts) exercises the callback, state, linking and session code
// that all three providers share. Better Auth 1.7.1 compiles these two providers' endpoints in, so
// they cannot be pointed at a mock (CUR-1552). Hugging Face goes through genericOAuth
// rather than socialProviders, but the button calls the same sign-in/social endpoint.
//
// redirect_uri: Better Auth builds it from PUBLIC_ORIGIN, which is develop's origin on every preview
// (the provider consoles register
// develop's and production's callbacks only). So a preview sends develop's callback, and develop or
// production sends its own. Anything else is a callback the provider would refuse. Production's chat
// is alpha since CUR-4439 and builds its own origin (`/chat/api/auth/callback/<id>` is reserved there,
// so it keeps its prefix); www stays listed while it still answers sign-in.

const REGISTERED_ORIGINS = [
	'https://develop.aipotluck.org',
	'https://alpha.aipotluck.org',
	'https://www.aipotluck.org'
];
const PREVIEW_AUTH_ORIGIN = 'https://develop.aipotluck.org';

const PROVIDERS = [
	{
		name: 'Google',
		id: 'google',
		authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
		// Better Auth's defaults for Google; betterAuth.ts sets no scope of its own.
		scope: ['email', 'openid', 'profile'],
		oidc: false
	},
	{
		name: 'GitHub',
		id: 'github',
		authorize: 'https://github.com/login/oauth/authorize',
		// user:email is what lets a person whose GitHub email is private sign in at all.
		scope: ['read:user', 'user:email'],
		oidc: false
	},
	{
		name: 'Hugging Face',
		id: 'huggingface',
		// From Hugging Face's discovery document, which genericOAuth reads at startup.
		authorize: 'https://huggingface.co/oauth/authorize',
		scope: ['email', 'openid', 'profile'],
		// An OIDC provider, so the request carries a nonce. Its client id is a registered id or this
		// app's own CIMD document URL; sending the `__CIMD__` sentinel verbatim got "Invalid client_id"
		// from Hugging Face (betterAuth.ts, hfClientId).
		oidc: true
	}
] as const;

/** The origin Better Auth should name in redirect_uri when the app is served from `baseURL`. */
function expectedAuthOrigin(baseURL: string): string {
	const origin = new URL(baseURL).origin;
	return REGISTERED_ORIGINS.includes(origin) ? origin : PREVIEW_AUTH_ORIGIN;
}

// Better Auth limits every /sign-in/* path to 3 requests per 10 s per IP (its rate-limiter's
// default rule). A CI runner is one IP for every worker, so this spec and mock-oidc-sign-in.spec.ts
// can spend that budget between them. A 429 there is not the failure this spec names, so it waits
// out the window and clicks once more, which is what a person would do.
const SIGN_IN_WINDOW_MS = 10_000;

/** Clicks the provider's button and returns the authorize URL the browser was sent to, stopped
 *  before it left. */
async function authorizeUrlFor(page: Page, buttonName: string, authorize: string): Promise<URL> {
	let resolveUrl: (url: string) => void;
	const sent = new Promise<string>((resolve) => (resolveUrl = resolve));
	await page.route(
		(url) => `${url.origin}${url.pathname}` === authorize,
		async (route) => {
			resolveUrl(route.request().url());
			// A 204 to a navigation leaves the current document in place. abort() would commit
			// Chrome's error page, which the recording shows as a blank screen a person never meets
			// (CUR-2737, CUR-2738).
			await route.fulfill({ status: 204 });
		}
	);
	const button = page.getByRole('button', { name: `Continue with ${buttonName}` });
	const clickAndRead = async () => {
		const response = page.waitForResponse(
			(r) => r.url().endsWith('/api/auth/sign-in/social') && r.request().method() === 'POST'
		);
		await button.click();
		return (await response).status();
	};

	let status = await clickAndRead();
	if (status === 429) {
		await page.waitForTimeout(SIGN_IN_WINDOW_MS);
		status = await clickAndRead();
	}
	expect(status, `sign-in/social answered ${status} for ${buttonName}`).toBe(200);
	const url = new URL(await sent);
	// The 204 left this page in place, the way a slow provider does before its first byte, and
	// sign-in/social has already answered. The button has to keep saying it is on its way and refuse a
	// second click until the page is gone (CUR-2739). Holding the provider's response open instead
	// would stall these reads, since a locator waits for a pending navigation to finish.
	await expect(
		button,
		'the button went back to its idle label while the browser was still leaving for the provider'
	).toHaveText(/Redirecting…/);
	await expect(button, 'a second click is open while the first is still leaving').toBeDisabled();
	// The provider is stubbed, so this page never leaves and the button stays on Redirecting…. Without
	// the caption the recording ends on a button that seems stuck, which is the finding CUR-2739 fixed.
	await captionForRecording(
		page,
		`${buttonName} stubbed out by the test: the browser was sent there and stopped before it left`,
		{ at: 'top' }
	);
	await holdForRecording(page);
	return url;
}

/** Seconds of blank tab can follow this page's request (CUR-2843) while the server answers
 *  in under 60 ms. These are the browser's own milestones for the sign-in page, from navigation start,
 *  so a run's meta.json says whether the time goes to the response, the first paint, or the load. */
async function recordSignInPageTiming(page: Page) {
	const t = await page.evaluate(() => {
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		const fcp = performance.getEntriesByName('first-contentful-paint')[0];
		// A slow first paint with a fast response means the gap is assets
		// the page waits on. The three that finished last before DOM ready name it.
		const lastBeforeReady = (
			performance.getEntriesByType('resource') as PerformanceResourceTiming[]
		)
			.filter((r) => r.responseEnd <= nav.domContentLoadedEventEnd)
			.sort((a, b) => b.responseEnd - a.responseEnd)
			.slice(0, 3)
			.map((r) => ({
				path: new URL(r.name).pathname.split('/').slice(-1)[0] || new URL(r.name).pathname,
				start: r.startTime,
				end: r.responseEnd,
				kb: r.transferSize / 1024
			}));
		// Fonts here are font-display: swap, so they never hold the first paint. So when the last three assets are all fonts or a lazy chunk,
		// the paint was waiting on something else, which leaves
		// the stylesheets and scripts Chrome marks render-blocking as what the paint waited on.
		const blocking = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
			.filter(
				(r) =>
					(r as PerformanceResourceTiming & { renderBlockingStatus?: string })
						.renderBlockingStatus === 'blocking'
			)
			.sort((a, b) => b.responseEnd - a.responseEnd)
			.map((r) => ({
				path: new URL(r.name).pathname.split('/').slice(-1)[0] || new URL(r.name).pathname,
				start: r.startTime,
				end: r.responseEnd,
				kb: r.transferSize / 1024
			}));
		return {
			responseEnd: nav.responseEnd,
			firstContentfulPaint: fcp?.startTime ?? -1,
			domContentLoaded: nav.domContentLoadedEventEnd,
			load: nav.loadEventEnd,
			lastBeforeReady,
			blocking
		};
	});
	const list = (rs: typeof t.lastBeforeReady) =>
		rs
			.map((r) => `${r.path} ${Math.round(r.start)}–${Math.round(r.end)} ms ${Math.round(r.kb)} KB`)
			.join('; ');
	recordMeasurement({
		name: 'Sign-in page first paint',
		value: Math.round(t.firstContentfulPaint),
		unit: 'ms',
		detail: `from navigation start: response ${Math.round(t.responseEnd)} ms, DOM ready ${Math.round(t.domContentLoaded)} ms, load ${Math.round(t.load)} ms; render-blocking (${t.blocking.length}), latest first: ${list(t.blocking) || 'none'}; last assets before DOM ready: ${list(t.lastBeforeReady) || 'none'}`
	});
}

for (const provider of PROVIDERS) {
	test(
		`the ${provider.name} button sends the browser to ${provider.name} with our client, a registered callback, the configured scopes, a state and a PKCE challenge`,
		{ tag: '@A1' },
		async ({ page, baseURL }) => {
			// The row's span takes in the provider click: authorizeUrlFor answers that navigation with a
			// 204, so the screen at the end is still the chooser with every way in side by side.
			const url = await journeyStep(page, 'A1', 4, async () => {
				await page.goto(chatPath('/login'), { waitUntil: 'load' });
				await recordSignInPageTiming(page);
				await expect(
					page.getByRole('button', { name: `Continue with ${provider.name}` }),
					`no ${provider.name} button on the sign-in screen`
				).toBeVisible({ timeout: 15_000 });
				return authorizeUrlFor(page, provider.name, provider.authorize);
			});
			const q = url.searchParams;

			expect(q.get('response_type')).toBe('code');
			expect(q.get('client_id') ?? '', 'client_id is missing or empty').not.toBe('');
			expect(q.get('redirect_uri')).toBe(
				`${expectedAuthOrigin(baseURL!)}/chat/api/auth/callback/${provider.id}`
			);
			expect((q.get('scope') ?? '').split(' ').sort()).toEqual([...provider.scope]);
			expect(q.get('state') ?? '', 'state is missing or too short to resist guessing').toMatch(
				/^[A-Za-z0-9_-]{16,}$/
			);
			expect(q.get('code_challenge_method')).toBe('S256');
			expect(q.get('code_challenge') ?? '').toMatch(/^[A-Za-z0-9_-]{43}$/);
			if (provider.oidc) {
				expect(q.get('nonce') ?? '', 'an OIDC request needs a nonce').toMatch(
					/^[A-Za-z0-9_-]{16,}$/
				);
				// A PR preview sends a registered client id and develop sends its CIMD document URL; both
				// are valid. The failure to catch is the sentinel going out verbatim.
				const clientId = q.get('client_id') ?? '';
				expect(clientId, 'the __CIMD__ sentinel must be resolved before it is sent').not.toBe(
					'__CIMD__'
				);
				if (/^https?:/.test(clientId)) {
					expect(clientId, 'a CIMD client id must be our own metadata document').toBe(
						`${expectedAuthOrigin(baseURL!)}/chat/.well-known/oauth-cimd`
					);
				}
			}
		}
	);
}
