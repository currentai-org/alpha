// e2e-product: @chat
// e2e-area: @agent @settings
//
// A signed-in person connects their Google account from Settings → Connectors, then asks a question a
// file in their Drive answers, and the turn calls the connector's read-only Drive search.
//
// Google and the connector are answered inside the app under the `google_connector_stub` fault
// (src/lib/chat/server/connectors/googleE2eStub.ts); everything between them is the real code: the
// consent URL, the sealed state cookie, openid-client's code exchange, the sealed refresh token, the
// refresh, and the MCP client listing and calling the tools with the access token as its bearer. Only
// Google's consent screen is answered here, by redirecting back to the callback as Google does after
// the person allows it.
//
// Runs in mock-model-e2e.sh only, which configures Connect Google with placeholders, runs aimock, and
// hands this spec its fault token as MOCK_E2E_FAULT_TOKEN. @mock-only keeps every other run, where
// Connect Google is not configured and no fixture answers the question, from collecting it.
import { test, expect, type Page } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { faultInjectionHeaders, type FaultInjectionName } from './helpers/faultInjection';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { openStepByStep } from './helpers/xray';

const FAULT: FaultInjectionName = 'google_connector_stub';
/** googleE2eStub.ts's stand-ins: the consent host, the account, and the fact only the Drive search returns. */
const CONSENT_HOST = 'https://accounts-google.e2e.invalid';
const STUB_EMAIL = 'drive-e2e@example.org';
const DRIVE_FACT = 'plot 7 waters on Thursdays';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** The question e2e/mock-model/fixtures.json answers with a call to the Drive search, then with the fact. */
const QUESTION = 'What does the allotment rota in my Drive say about plot 7?';

const MOCK_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/v1\/?$/, '');

/** Sends the fault's headers on this app's requests whose path `matches`, and on no other. */
async function stubOn(page: Page, matches: (pathname: string) => boolean): Promise<void> {
	// mock-model-e2e.sh keeps E2E_FAULT_INJECT_TOKEN from Playwright, so the other specs' fixtures do
	// not arm on it, and hands this spec the token under its own name.
	const headers = faultInjectionHeaders(FAULT, process.env.MOCK_E2E_FAULT_TOKEN);
	const origin = new URL(process.env.SCENARIO_BASE_URL ?? 'http://localhost').origin;
	await page.route(
		(url) => url.origin === origin && matches(url.pathname),
		(route) => route.continue({ headers: { ...route.request().headers(), ...headers } })
	);
}

/** The tool messages aimock received, as text, from its request journal. */
async function toolResultsSeenByModel(page: Page): Promise<string[]> {
	expect(MOCK_BASE, `OPENAI_BASE_URL is not aimock on loopback: ${MOCK_BASE}`).toMatch(
		/^http:\/\/127\.0\.0\.1:\d+$/
	);
	const res = await page.request.get(`${MOCK_BASE}/__aimock/journal`);
	expect(res.ok(), `aimock's journal answered ${res.status()}`).toBe(true);
	const entries = (await res.json()) as {
		path?: string;
		body?: { messages?: { role?: string; content?: unknown }[] };
	}[];
	return entries
		.filter((e) => e.path?.endsWith('/chat/completions'))
		.flatMap((e) => e.body?.messages ?? [])
		.filter((m) => m.role === 'tool')
		.map((m) => JSON.stringify(m.content));
}

test(
	'a person connects Google and asks about a Drive file, and the turn calls the read-only Drive search',
	{ tag: ['@root', '@mock-model', '@mock-only'] },
	async ({ page }, testInfo) => {
		// Sign-in, the connect round trip, a 90 s turn, and slack.
		test.setTimeout(180_000);
		await signInAsFreshUser(page);

		// The connectors page lists the connector's tools, the connect and the callback trade with
		// Google, and the send runs the turn: each request asks for the stand-ins on its own.
		await stubOn(page, (p) => /\/settings\/connectors(\/__data\.json)?$/.test(p));
		await stubOn(page, (p) => p.endsWith('/api/connectors/google/callback'));

		// Playwright does not route the hop a redirect makes, so the connect's 303 to Google's consent
		// screen is caught here instead: the server's response is fetched without following it, its
		// consent URL read, and the state cookie it sets handed to the browser with no redirect. The spec
		// then plays Google sending the person back, navigating to the callback itself.
		const asked: string[] = [];
		let back: URL | undefined;
		await page.route(
			(url) => url.pathname.endsWith('/api/connectors/google/connect'),
			async (route) => {
				const res = await route.fetch({
					headers: {
						...route.request().headers(),
						...faultInjectionHeaders(FAULT, process.env.MOCK_E2E_FAULT_TOKEN)
					},
					maxRedirects: 0
				});
				const consent = new URL(res.headers()['location'] ?? 'about:blank');
				expect(
					consent.origin,
					`the connect did not send the person to the consent screen (${res.status()})`
				).toBe(CONSENT_HOST);
				asked.push(...(consent.searchParams.get('scope') ?? '').split(' '));
				back = new URL(consent.searchParams.get('redirect_uri') ?? '');
				back.searchParams.set('code', 'e2e-code');
				back.searchParams.set('state', consent.searchParams.get('state') ?? '');
				const headers = { ...res.headers() };
				delete headers['location'];
				await route.fulfill({ response: res, status: 200, headers, body: 'consent' });
			}
		);

		await page.goto(chatPath('/settings/connectors'), { waitUntil: 'load' });
		const google = page.locator('[data-connector-google]');
		await expect(
			google.locator('[data-connector-google-state="disconnected"]'),
			'Settings → Connectors does not offer Connect Google to a signed-in person'
		).toContainText('Gmail, Calendar and Drive', { timeout: 30_000 });
		await testInfo.attach('connect-google', {
			body: await google.screenshot(),
			contentType: 'image/png'
		});

		await google.getByRole('link', { name: 'Connect Google' }).click();
		await expect
			.poll(() => back?.href, { message: 'the connect never reached the consent screen' })
			.toBeTruthy();
		await page.goto(back!.href, { waitUntil: 'load' });
		await expect(page, 'the callback did not come back to Connectors as connected').toHaveURL(
			/\/settings\/connectors\?google=connected/,
			{ timeout: 30_000 }
		);
		// The callback's redirect to Connectors was a hop the fault header did not ride: load the page
		// again through its route, so it lists the stand-in connector's tools.
		await page.reload({ waitUntil: 'load' });
		expect(asked, 'the consent did not ask for Drive read-only').toContain(DRIVE_SCOPE);
		expect(
			asked.filter((s) => s.startsWith('https://') && !s.endsWith('.readonly')),
			'the consent asked for a scope that could change something'
		).toEqual([]);
		await expect(google.locator('[data-connector-google-state="connected"]')).toContainText(
			`Connected as ${STUB_EMAIL}`
		);
		await expect(google).toContainText('Gmail, Calendar and Drive');
		await expect(
			page.locator('[data-connector-tool="google__search_drive_files"]'),
			"the connected account's Drive search is not listed, so the refresh or the listing failed"
		).toBeVisible();
		await expect(page.locator('[data-connector-tool="google__search_drive_files"]')).toContainText(
			'Read-only'
		);
		await testInfo.attach('google-connected', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});

		// The send is the request that runs the turn and lists the person's servers.
		await stubOn(page, (p) => /\/conversation\/[a-f0-9]+$/.test(p));
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await expect(composer).toBeVisible({ timeout: 30_000 });
		await composerHydrated(page);
		await composer.fill(QUESTION);
		await sendOpensConversation(page, { timeout: 60_000 });
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply), 'the Drive question never finished').toBeVisible({
			timeout: 90_000
		});
		// The model received the Drive search's result in a tool message. The answer's wording is the
		// mock's fixture, so the proof is what our server sent the model, read from aimock's journal.
		const toolResults = await toolResultsSeenByModel(page);
		expect(
			toolResults.some((t) => t.includes(DRIVE_FACT)),
			`no tool result the model received carries the Drive file's text: ${JSON.stringify(toolResults).slice(0, 500)}`
		).toBe(true);

		// X-ray's Step by step names the call.
		await openStepByStep(page, reply, {
			disclosure: { timeout: 30_000 },
			tab: { timeout: 10_000 }
		});
		const steps = page.locator('[data-xray-steps]');
		await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
		await expect(steps, 'Step by step does not show the Drive search on google').toContainText(
			'search_drive_files on google'
		);
	}
);
