// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';

// Connect Hugging Face (CUR-2932). Settings → Storage (its "Link your own Hugging Face bucket" section) offers a consent on the storage OAuth
// app, separate from sign-in's app, that asks for `contribute-repos` and nothing wider.
//
// The consent screen itself is huggingface.co's and needs a real person's account, so the spec stops
// the browser at the authorize URL and reads what Alpha asked for. It then drives the callback on this
// preview: a forged state is refused before any code is traded, and the state the connect route really
// minted gets past that check and on to Hugging Face, which refuses the made-up code.

const CONNECT = /\/chat\/api\/storage\/locations\/hf\/connect(\?|$)/;
const AUTHORIZE = 'https://huggingface.co/oauth/authorize';

async function openLinkSection(page: Page): Promise<void> {
	// Reached through the UI: the settings nav's Storage entry, not a typed URL.
	await page.goto('/chat/settings', { waitUntil: 'commit' });
	await page
		.getByRole('link', { name: 'How much storage you use, where new files go, and linked buckets' })
		.click({ timeout: 30_000 });
	await expect(page.getByTestId('storage-locations')).toBeVisible({ timeout: 30_000 });
	// Linking a bucket is its own section of Settings → Storage, in plain view (CUR-4363).
	await expect(page.getByTestId('storage-connect')).toBeVisible();
}

/** Click Connect, hold the browser at Hugging Face's authorize URL, and return that URL. */
async function startConnect(page: Page): Promise<URL> {
	// The connect route answers with a 303 to huggingface.co, and Playwright calls a route handler only
	// for a request's first URL, never for where a redirect lands. So the real connect route runs here
	// with redirects held, and the browser is shown a stand-in in place of following the Location.
	// route.fetch shares the context's cookie store, so the connect cookie it sets is the browser's.
	let authorize: URL | null = null;
	await page.route(CONNECT, async (route) => {
		const res = await route.fetch({ maxRedirects: 0 });
		const location = res.headers()['location'] ?? '';
		if (!location.startsWith(AUTHORIZE)) return route.fulfill({ response: res });
		authorize = new URL(location);
		await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>consent stand-in</p>' });
	});
	await page
		.getByTestId('storage-connect')
		.getByRole('button', { name: 'Connect Hugging Face' })
		.click();
	await expect(page.getByText('consent stand-in')).toBeVisible({ timeout: 30_000 });
	expect(authorize, 'the Connect button never reached Hugging Face’s authorize URL').not.toBeNull();
	return authorize!;
}

test.beforeEach(async ({ context, baseURL }) => {
	await setFlagOverrides(context, baseURL!, {
		'custodial-storage-view': true,
		'storage-locations': true
	});
});

// The section reads as two titled choices, the recommended one first, with the approval and
// token detail behind a disclosure each rather than a paragraph under every field (CUR-4659).
test(
	'Link your own bucket offers Make a new bucket (recommended) before Link a bucket you already have, with the approval and token detail one click away',
	{ tag: ['@preview-only', '@A3', '@CUR-4659'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);
		const section = page.getByTestId('storage-link-section');
		await expect(section.getByRole('heading', { level: 3 })).toHaveText([
			'Make a new bucket',
			'Link a bucket you already have'
		]);
		const connectChoice = section.getByTestId('storage-connect-choice');
		await expect(connectChoice).toContainText('Recommended');
		await expect(connectChoice.getByTestId('storage-connect')).toBeVisible();
		await expect(
			section.getByTestId('storage-link-existing-choice').getByTestId('link-bucket-form')
		).toBeVisible();

		// The approval detail is folded away until asked for, then says how to revoke.
		await expect(section.getByTestId('storage-connect-how')).toBeHidden();
		await connectChoice.getByRole('button', { name: 'How connecting works' }).click();
		await expect(section.getByTestId('storage-connect-how')).toContainText(
			'revoke access any time in your Hugging Face settings'
		);

		await expect(section.getByTestId('storage-token-how')).toBeHidden();
		await section.getByRole('button', { name: 'How Alpha uses your token' }).click();
		await expect(section.getByTestId('storage-token-how')).toContainText('stores it encrypted');
	}
);

test(
	'Connect Hugging Face asks the storage app for contribute-repos only, with PKCE, and returns to this deployment’s callback',
	{ tag: ['@preview-only', '@A3', '@CUR-2932'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);

		const url = await startConnect(page);
		expect(
			url.searchParams.get('scope'),
			'the consent must not ask for more than contribute-repos'
		).toBe('openid profile contribute-repos');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')?.length ?? 0).toBeGreaterThan(40);
		expect(url.searchParams.get('state')?.length ?? 0).toBeGreaterThan(20);
		expect(
			url.searchParams.get('client_id'),
			'Connect must use a configured client id'
		).toBeTruthy();
		expect(new URL(url.searchParams.get('redirect_uri')!).pathname).toBe(
			'/chat/api/storage/locations/hf/callback'
		);
	}
);

test(
	'a callback carrying a forged state is refused with a plain message and links nothing, while the minted state gets past that check',
	{ tag: ['@preview-only', '@A3', '@CUR-2932'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);
		const minted = (await startConnect(page)).searchParams.get('state')!;

		// Forged: the connect cookie is present, the state is not the one it holds.
		await page.goto(
			'/chat/api/storage/locations/hf/callback?state=forged-state-value-0000&code=made-up'
		);
		await expect(page).toHaveURL(/\/chat\/settings\/storage\?connect_error=state$/, {
			timeout: 30_000
		});
		await expect(page.getByTestId('storage-connect-outcome')).toContainText(
			'didn’t match this account'
		);
		// The callback lands at the top of the page; the outcome is brought into view, not left below the fold.
		await expect(page.getByTestId('storage-connect-outcome')).toBeInViewport();
		await expect(page.locator('[data-testid=storage-location]')).toHaveCount(1);

		// The callback spent the cookie on the forged attempt, so the real state now fails the same check
		// rather than reaching Hugging Face: one connect, one callback.
		await page.goto(
			`/chat/api/storage/locations/hf/callback?state=${encodeURIComponent(minted)}&code=made-up`
		);
		await expect(page).toHaveURL(/connect_error=state$/, { timeout: 30_000 });

		// A fresh connect, then its own state with a made-up code: the state check passes, Hugging Face
		// refuses the code, and the page says the account wasn't connected.
		await openLinkSection(page);
		const second = (await startConnect(page)).searchParams.get('state')!;
		await page.goto(
			`/chat/api/storage/locations/hf/callback?state=${encodeURIComponent(second)}&code=made-up`
		);
		await expect(page).toHaveURL(/connect_error=denied$/, { timeout: 30_000 });
		await expect(page.getByTestId('storage-connect-outcome')).toContainText(
			'Hugging Face wasn’t connected'
		);
		await expect(page.locator('[data-testid=storage-location]')).toHaveCount(1);
	}
);

// The tests above stub the connect route, so the browser never follows its 303 to huggingface.co, and
// the page's CSP form-action, which Chrome checks against every redirect a form submission follows,
// never got a say. On production it blocked that redirect and the button did nothing. Here nothing is
// stubbed: the click has to leave the page for Hugging Face's authorize URL.
test(
	'clicking Connect Hugging Face takes the browser to Hugging Face, with no CSP block on the redirect',
	{ tag: ['@preview-only', '@A3', '@CUR-2932'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);
		await page.evaluate(() => {
			(window as unknown as { __cspBlocks: string[] }).__cspBlocks = [];
			// eslint-disable-next-line svelte/no-add-event-listener -- runs in the page under test, not a component
			document.addEventListener('securitypolicyviolation', (e) =>
				(window as unknown as { __cspBlocks: string[] }).__cspBlocks.push(e.violatedDirective)
			);
		});
		const leftForHf = page.waitForRequest((r) => r.url().startsWith(AUTHORIZE), {
			timeout: 30_000
		});
		await page
			.getByTestId('storage-connect')
			.getByRole('button', { name: 'Connect Hugging Face' })
			.click();
		const blocks = await Promise.race([
			leftForHf.then(() => null),
			page
				.waitForFunction(
					() => (window as unknown as { __cspBlocks: string[] }).__cspBlocks.length > 0,
					null,
					{ timeout: 30_000 }
				)
				.then(() =>
					page.evaluate(() => (window as unknown as { __cspBlocks: string[] }).__cspBlocks)
				)
		]);
		expect(
			blocks,
			`the page's CSP blocked the Connect navigation: ${blocks?.join(', ')}`
		).toBeNull();
		await expect(page).toHaveURL(/^https:\/\/huggingface\.co\//, { timeout: 30_000 });
	}
);

// One bucket or several, each named. Connect takes a bucket name, carries it through
// the consent in the sealed state, and refuses a name that is not a Hugging Face repo name before it
// leaves for the consent.
test(
	'Connect with a bucket name still asks Hugging Face for contribute-repos only, and a name that is not a repo name is refused before the consent',
	{ tag: ['@preview-only', '@A3', '@CUR-2930'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);
		await page.getByTestId('storage-connect').getByLabel('Bucket name').fill('photos');
		const url = await startConnect(page);
		expect(url.searchParams.get('scope')).toBe('openid profile contribute-repos');

		const refused = await page.request.get('/chat/api/storage/locations/hf/connect?bucket=a%2Fb', {
			maxRedirects: 0
		});
		expect(refused.status(), 'a bucket name with a slash reached the consent').toBe(303);
		expect(refused.headers()['location']).not.toContain('huggingface.co');
	}
);

// A name Hugging Face would refuse used to end on a bare 400 page with the name gone, and
// `trail-` got past our check to fail at Hugging Face as "try again in a minute" (CUR-4234).
test(
	'a bucket name Hugging Face would refuse comes back to Storage with a message saying why and the name still in the field',
	{ tag: ['@preview-only', '@A3', '@CUR-4234'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);
		await openLinkSection(page);
		await page.getByTestId('storage-connect').getByLabel('Bucket name').fill('trail-');
		await page
			.getByTestId('storage-connect')
			.getByRole('button', { name: 'Connect Hugging Face' })
			.click();

		await expect(page).toHaveURL(/\/chat\/settings\/storage\?connect_error=name&bucket=trail-$/, {
			timeout: 30_000
		});
		await expect(page.getByTestId('storage-connect-outcome')).toContainText(
			'won’t take trail- as a bucket name'
		);
		await expect(
			page.getByTestId('storage-connect').getByLabel('Bucket name'),
			'the refused name was not handed back to fix'
		).toHaveValue('trail-');
	}
);

// Connect again with no name lands on the bucket already linked (CUR-3326). The callback refreshes it
// and adds nothing (its route spec proves the redirect), and the page has to say so rather than
// report a new connection over an unchanged list.
test(
	'connecting again to a bucket that is already linked says so, and points at the bucket name for a second one',
	{ tag: ['@preview-only', '@A3', '@CUR-3326'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await signInAsFreshUser(page);
		await page.goto('/chat/settings/storage?connected=refreshed&bucket=someone%2Falpha-files');
		const outcome = page.getByTestId('storage-connect-outcome');
		await expect(outcome).toContainText('someone/alpha-files was already linked', {
			timeout: 30_000
		});
		await expect(outcome).toContainText('connect again with a different bucket name');
		await expect(outcome).not.toContainText('Hugging Face is connected');
	}
);
