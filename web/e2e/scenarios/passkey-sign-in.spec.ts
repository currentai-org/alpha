// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { chatEntry } from './helpers/chatEntry';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { turnDone } from './helpers/turn';
import { watchForChatLanding } from './helpers/landingWatch';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// A1 (CUR-1696): passkey is one of the five sign-in routes and the only one with no CI coverage at
// all. Unlike the OAuth three (CUR-1551/CUR-1552), there is no third party in it — WebAuthn is a
// browser API, and Chrome exposes a virtual authenticator over CDP that Playwright can drive
// directly, no mock server to keep alive.
//
// Registering a passkey requires an existing session (addPasskey() lives in Settings → Account), so
// this signs in with email-OTP first, then adds a passkey, signs out, and signs back in with ONLY
// the passkey — proving the credential itself works, not that the OTP session carried over.
//
// New file rather than a new test in sign-in.spec.ts: e2e-scope-classify.mjs treats any modified
// file's added test.skip() as unconditionally UNSAFE (CUR-1615) with no override, because a
// conditional skip is indistinguishable from an unconditional one by counting.
// The same test.skip(!present, reason) shape in voice-and-attachments.spec.ts fails the gate on its third
// addition. A brand-new file has no "before"
// blob to diff against and is unconditionally safe regardless of what it contains.
//
// RP-ID assertion: rather than hand-computing betterAuth.ts's passkeyRpId (APEX_DOMAIN when
// VERCEL_ENV/VERCEL_GIT_COMMIT_REF says production/develop, else PUBLIC_ORIGIN's hostname — logic
// this test has no access to from outside the deployment, and duplicating it would just move the
// same bug into the test), this reads the credential's ACTUAL rpId back from the virtual
// authenticator via CDP and checks it against the WebAuthn spec's own constraint: rpId must equal
// the serving hostname or be one of its parent domains. That is exactly the constraint the browser
// itself enforces at creation time, so it goes red for precisely the failure CUR-1696 names — "the
// day Alpha moves to a domain where APEX_DOMAIN's hardcoded aipotluck.org is no longer a suffix of
// the real origin" — without predicting what the new value should be. Runs on every
// deployment, PR previews included: CUR-1708 gave those an RP ID naming their own host.
test(
	'a passkey registered through the UI survives sign-out and signs back in, bound to a valid RP ID',
	// @apex-rp: develop's own build sets rpID to the apex (computePasskeyRp), so the gallery runs this
	// test against the alias rather than develop's raw deployment URL (CUR-3098).
	{ tag: ['@A1', '@apex-rp', '@CUR-1696'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		// A guest who lands on the chat entry may get the first-visit welcome, which covers the composer.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');

		// CDP session up front: WebAuthn.enable has to be active before any navigator.credentials call,
		// including the conditional-UI autofill probe +page.svelte's login screen fires on mount.
		const cdp = await context.newCDPSession(page);
		await cdp.send('WebAuthn.enable', { enableUI: false });
		const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true
			}
		});

		// skipPendingLabelCheck: this test has no stake in CUR-1481/CUR-1487's pending-label timing —
		// see signIn.ts's own comment on that option for why the check is skipped rather than tightened.
		await signInWithEmailOtp(page, databaseUrl, freshTestEmail(), { skipPendingLabelCheck: true });

		// Registration lives in Settings → Account (CUR-649: named, not the bare "Passkey" fallback
		// every unnamed credential renders as — naming it here doubles as coverage that
		// the fix still holds).
		const PASSKEY_NAME = `CUR-1696 e2e ${Date.now()}`;
		await page.goto('/chat/settings/account', { waitUntil: 'load' });
		const addPasskey = page.getByRole('button', { name: /^Add a passkey$/ });
		// The server renders this enabled button before Svelte installs its click handler. `load`
		// does not wait for that hydration: the failed trace had no naming prompt or registration
		// request at all. As with composerHydrated, wait for Svelte's delegated handlers before clicking.
		await expect
			.poll(
				() =>
					addPasskey.evaluate((button) =>
						Object.getOwnPropertySymbols(button).some((key) => key.description === 'events')
					),
				{ timeout: 15_000, message: 'the Add a passkey button never hydrated' }
			)
			.toBe(true);
		await Promise.all([
			page.waitForEvent('dialog', { timeout: 15_000 }).then(async (dialog) => {
				expect(dialog.type(), 'adding a passkey must ask for its name').toBe('prompt');
				await dialog.accept(PASSKEY_NAME);
			}),
			addPasskey.click()
		]);
		await expect(
			page.getByText(PASSKEY_NAME),
			'the passkey was added but never rendered under its given name — CUR-649 regression'
		).toBeVisible({ timeout: 15_000 });

		const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
		expect(
			credentials,
			'the ceremony completed but the virtual authenticator holds no credential'
		).toHaveLength(1);
		const rpId = credentials[0].rpId;
		const hostname = new URL(baseURL!).hostname;
		expect(
			hostname === rpId || hostname.endsWith(`.${rpId}`),
			`registered credential's RP ID "${rpId}" is not the serving hostname "${hostname}" or one of its ` +
				'parent domains — WebAuthn would have refused to create this credential if it genuinely violated ' +
				"that constraint, so either the browser's own enforcement is being bypassed somehow, or " +
				'betterAuth.ts computed an RP ID that happens to still validate here but is heading toward the ' +
				'"Alpha moves to a new domain" breakage CUR-1696 was filed to catch early'
		).toBe(true);

		// Settings renders as a modal drawer over the chat shell rather than a plain page, so the
		// "Log out" control underneath it is laid out and CSS-visible but covered by the drawer's own
		// backdrop — a click there times out on "subtree intercepts pointer events".
		// Returning to a clean chat page closes the drawer and puts the nav rail's real click target
		// back on top, instead of chasing the backdrop's close button.
		await page.goto(chatEntry(), { waitUntil: 'load' });

		// Log out from the account menu; the account button then names the guest session.
		await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
		await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
			timeout: 15_000
		});

		// Signing in has to bring a person back to the conversation they were in (CUR-1677, CUR-1808),
		// with no new-chat landing in between, on every route and not only email (sign-in.spec.ts walks
		// that one). Signed out now, start a conversation in this same page so its anonymous session is
		// the one sign-in carries, and wait for the answer so nothing is in flight when it does.
		const question = 'Name one island in Greece in one short sentence.';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationUrl = page.url();
		await expect(
			turnDone(page.locator('[data-message-role="assistant"]').last()),
			'no completed-answer control appeared within 90s, so there was no finished conversation for sign-in to carry'
		).toBeVisible({ timeout: 90_000 });

		const landingSightings = await watchForChatLanding(page);

		// The login page fires a conditional-UI (autofill) passkey request on mount
		// (+page.svelte, CUR-609), and with presence simulation on, the authenticator answers it before
		// the click lands — sign-in completes, the page navigates, and the click times out on a button
		// that is gone. Presence off while the page loads leaves that request pending; the button's own
		// ceremony replaces it, and presence back on is what lets that one, and only that one, answer (CUR-2037).
		await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });

		// When the button's options request is answered before the autofill's, the autofill's
		// challenge is the one stored and the button's sign-in fails with "Challenge not found". Left to
		// timing, the autofill usually wins first and the spec would pass with the fix removed, so
		// force that order: hold the page's first options request until a second one has been answered,
		// and hold the verify until the first has. Fixed, the button waits on the first, sends no
		// second while it is held, and the 3s cap lets it through. Both caps count from the first
		// request's arrival, so a slow login page can't spend them before the race is set up. The
		// click waits until that first request has arrived, so it is always the autofill's: a click
		// landing before the autofill fired would make the button's request the held one, and a reverted
		// fix would pass on a retry (CUR-2695).
		let optionsRequests = 0;
		let releaseFirst = () => {};
		let firstAnswered = () => {};
		let firstArrived = () => {};
		const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstDone = new Promise<void>((resolve) => (firstAnswered = resolve));
		const autofillAsked = new Promise<void>((resolve) => (firstArrived = resolve));
		await page.route('**/passkey/generate-authenticate-options**', async (route) => {
			const n = ++optionsRequests;
			if (n === 1) {
				firstArrived();
				setTimeout(releaseFirst, 3_000);
				setTimeout(firstAnswered, 10_000);
				await firstHeld;
			}
			await route.fulfill({ response: await route.fetch() });
			if (n === 1) firstAnswered();
			else releaseFirst();
		});
		await page.route('**/passkey/verify-authentication**', async (route) => {
			await firstDone;
			await route.continue();
		});

		// Through the rail's "Log in", as a person would: it carries this conversation as `next`. The
		// click goes in while the autofill's options request is still held, before it is answered.
		await journeyStep(page, 'A1', 4, async () => {
			await (await accountMenuItem(page, 'Log in', { timeout: 20_000 })).click();
			const passkeyButton = page.getByRole('button', { name: /^Use a passkey/ });
			await expect(passkeyButton).toBeVisible({ timeout: 15_000 });
			await Promise.race([
				autofillAsked,
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									"the login page's autofill never asked for passkey options within 15s, so there was no race to force"
								)
							),
						15_000
					)
				)
			]);
			await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
			await passkeyButton.click();

			// automaticPresenceSimulation on a resident, user-verified virtual authenticator answers the
			// discoverable-credential prompt with no further interaction — no tap, no second dialog.
			//
			// Back on the same conversation, signed in, with the question still there.
			await expect(
				page,
				'a passkey sign-in did not return to the conversation it started from'
			).toHaveURL(conversationUrl, { timeout: 15_000 });
			await expect(accountButton(page)).toHaveAccessibleName(/signed in as /i, {
				timeout: 15_000
			});
		});
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		expect(
			optionsRequests,
			"the login page sent fewer than two passkey options requests, so the autofill and the button never raced and CUR-2695 wasn't exercised"
		).toBeGreaterThanOrEqual(2);
		await expect(
			page.getByText(question),
			'the passkey sign-in returned to the conversation but did not carry it onto the account'
		).toBeVisible({ timeout: 15_000 });
		expect(
			landingSightings,
			'after the passkey was accepted, the new-chat landing rendered before this conversation came back'
		).toEqual([]);
	}
);
