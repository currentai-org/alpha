import { test, expect, chromium, type Page } from '@playwright/test';
import { setupRecast, narrate, click, typeText, zoom } from 'playwright-recast/helpers';
import { highlight, waitForNarration, openHome, clickIntoChat, TOUR_RECAST } from './show';
import { installOtpBypassHeader, signInWithEmailOtp } from '../scenarios/helpers/signIn';
import { readSignInOtp } from '../scenarios/helpers/otp';
import { accountButton } from '../scenarios/helpers/accountMenu';
import { turnDone } from '../scenarios/helpers/turn';

// The A1 walkthrough (CUR-2789): docs/journeys/a1-sign-in.md walked as one person in one sitting,
// rows 1–8, then 11, then 10, so the story ends on signing out. Row 9 needs a real second OAuth
// account, so it is told over the chooser's own line about linking providers rather than walked.
//
// It is filmed for people. sign-in.spec.ts holds the assertions; the expects here are only the ones
// a viewer would notice going wrong, so a broken take fails instead of rendering.
// Every narrate() line is the voiceover, read by tools/tour-render from this run's trace.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const QUESTION = 'What is a good day hike near Lucerne?';
const PASSKEY_NAME = "Sam's phone";

// A readable address on screen. The OTP carve-out needs @example.org; the suffix keeps each run's
// account fresh.
const EMAIL = `sam.rivera.${Math.random().toString(36).slice(2, 7)}@example.org`;

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await narrate('First time in, Alpha says hello once, and gets out of the way.');
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

test('A1: try Alpha, then sign in when you want it to remember you', async ({ page, baseURL }) => {
	expect(DATABASE_URL, 'SCENARIO_DATABASE_URL is needed to read the sign-in code').toBeTruthy();
	await installOtpBypassHeader(page);

	// Row 1
	await openHome(page);
	await narrate(
		"This is A1, signing in. Sam has followed a link to AI Potluck. They aren't signed in, and nothing is going to make them."
	);
	await waitForNarration(page);
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);

	// Row 2
	const composer = page.getByLabel('Message AI Potluck');
	await narrate('They go straight to a question. No account, no wall.');
	await click(composer);
	await typeText(composer, QUESTION);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationUrl = page.url();
	const answer = page.locator('[data-message-role="assistant"]').last();
	await narrate('A real answer streams in. Alpha has earned its keep before asking for anything.');
	await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
	await waitForNarration(page);

	// Row 3
	await narrate(
		'When Sam wants Alpha to remember this, the account row at the foot of the rail has a plain Log in. Their choice, their timing.'
	);
	await click(accountButton(page));
	const logIn = page.getByRole('menuitem', { name: 'Log in' });
	await expect(logIn).toBeVisible();
	await waitForNarration(page);
	await click(logIn);

	// Row 4, with row 9's promise told over its own line
	const chooser = page.locator('[role="dialog"]:has(#signin-email)');
	await expect(page.locator('#signin-email')).toBeVisible({ timeout: 15_000 });
	await narrate(
		'Every way in sits side by side: an email code, Google, GitHub, Hugging Face, or a passkey. No single company is the gate.'
	);
	await zoom(chooser, 1.4);
	await waitForNarration(page);
	// The chooser's centred caption, found by place rather than wording: the walkthrough films
	// develop whichever branch pushes, so a PR that rewords it is filmed against the old line.
	// sign-in.spec.ts asserts the wording.
	const ownAccount = chooser.locator('p.text-center.type-caption');
	await highlight(ownAccount);
	await narrate(
		'And it says up front that an email code finds the account Sam already has, and that another way in is linked from Settings once signed in.'
	);
	await waitForNarration(page);

	// Row 5
	await narrate('Sam picks email.');
	await click(page.locator('#signin-email'));
	await typeText(page.locator('#signin-email'), EMAIL);
	await click(page.getByRole('button', { name: 'Continue with email' }));
	const sent = page.getByText(`We sent a 6-digit code to ${EMAIL}.`);
	await expect(sent).toBeVisible({ timeout: 20_000 });
	await narrate('The screen says plainly that a code is on its way, and where it went.');
	await highlight(sent);
	await waitForNarration(page);

	// Row 6
	const code = await readSignInOtp(DATABASE_URL!, EMAIL);
	await narrate('Six digits, and it goes through on the last one. There is no button to hunt for.');
	await zoom(page.locator('#signin-otp'), 1.6);
	await typeText(page.locator('#signin-otp'), code);

	// Rows 7 and 8
	await page.waitForURL(new RegExp(`${new URL(conversationUrl).pathname}$`), { timeout: 20_000 });
	await expect(accountButton(page)).toHaveAccessibleName(/signed in as /i, { timeout: 15_000 });
	await narrate(
		'They land back in the same conversation. The question and the answer came with them, and the rail now says who they are signed in as.'
	);
	await highlight(accountButton(page));
	await expect(page.getByText(QUESTION).first()).toBeVisible();
	await waitForNarration(page);

	// Row 11: the second device signs in off camera, as it would on someone's laptop. A browser of its
	// own, because a context from the test's browser would be recorded and traced into the take.
	const laptopBrowser = await chromium.launch();
	const laptop = await laptopBrowser.newContext({ baseURL });
	try {
		const laptopPage = await laptop.newPage();
		await signInWithEmailOtp(laptopPage, DATABASE_URL!, EMAIL, { skipPendingLabelCheck: true });

		await narrate(
			'Later, Sam signs in on a laptop as well. Both show up under Active sessions on the account page.'
		);
		await page.goto('/chat/settings/account', { waitUntil: 'load' });
		const sessions = page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Active sessions' }) });
		await expect(sessions.getByTestId('session-device')).toHaveCount(2, { timeout: 30_000 });
		await sessions.scrollIntoViewIfNeeded();
		await zoom(sessions, 1.5);
		await waitForNarration(page);

		await narrate('This one is marked as this device. Ending the other takes it off the list.');
		await click(sessions.getByRole('button', { name: 'End session' }));
		await expect(sessions.getByTestId('session-device')).toHaveCount(1, { timeout: 15_000 });
		await waitForNarration(page);

		await laptopPage.goto('/chat', { waitUntil: 'load' });
		await expect(accountButton(laptopPage)).toHaveAccessibleName('Account — guest', {
			timeout: 15_000
		});
		await narrate('The laptop is signed out the next time it loads a page.');
		await waitForNarration(page);
	} finally {
		await laptopBrowser.close();
	}

	// Managing ways in (CUR-3080), still on the account page. Email code is listed first and has no
	// button (CUR-3049).
	const providers = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Linked providers' }) });
	const emailRow = page.getByTestId('sign-in-method-email');
	await expect(emailRow).toBeVisible({ timeout: 15_000 });
	await narrate(
		'Linked providers lists every way in. Email code comes first, and it has no button: a code to this address always works, so it can’t be removed.'
	);
	await highlight(emailRow);
	await waitForNarration(page);

	// A passkey, added through Chrome's virtual authenticator the way passkey-sign-in.spec.ts adds
	// one. The page asks for its name in a browser prompt before the ceremony, and that prompt is
	// answered here, off the recording; nothing renames a passkey afterwards.
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable', { enableUI: false });
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	const passkeys = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Passkeys' }) });
	page.once('dialog', (dialog) => dialog.accept(PASSKEY_NAME));
	await narrate(
		'Sam adds a passkey, so this phone can sign in with a fingerprint. They name it first, so they can tell two apart later.'
	);
	await passkeys.scrollIntoViewIfNeeded();
	await click(passkeys.getByRole('button', { name: 'Add a passkey' }));
	const passkeyRow = passkeys.getByText(PASSKEY_NAME);
	await expect(passkeyRow, 'the passkey never appeared under its name').toBeVisible({
		timeout: 20_000
	});
	await waitForNarration(page);
	await narrate('It is listed under that name, with the kind of device and the day it was added.');
	await highlight(passkeyRow);
	await waitForNarration(page);
	await narrate('Remove takes it off the account straight away.');
	await click(passkeys.getByRole('button', { name: 'Remove' }));
	await expect(passkeys.getByText('No passkeys registered.')).toBeVisible({ timeout: 15_000 });
	await waitForNarration(page);

	// Link: the round trip needs a real GitHub account, which a recorded run doesn't have, so the take
	// films the hand-off to GitHub and comes back. The mock provider is loopback-only.
	const githubRow = providers.locator('div:has(> div > div:text-is("GitHub"))');
	await providers.scrollIntoViewIfNeeded();
	await narrate(
		'Google, GitHub and Hugging Face each have a Link button. Linking sends Sam to that company to approve it.'
	);
	await highlight(githubRow);
	await waitForNarration(page);
	await click(githubRow.getByRole('button', { name: 'Link' }));
	await page.waitForURL(/^https:\/\/github\.com\//, { timeout: 30_000 });
	await narrate(
		'This is GitHub’s own page, asking Sam to approve AI Potluck. Approving brings them back to the account page with GitHub listed.'
	);
	await waitForNarration(page);
	await page.goto('/chat/settings/account', { waitUntil: 'load' });
	await expect(emailRow).toBeVisible({ timeout: 15_000 });
	// The last linked provider's Unlink is off by rule, and the page says the email code
	// still works, so the line never claims the provider is Sam's only way in (CUR-3144).
	await narrate(
		'Each linked provider gets an Unlink button. While only one is linked, Unlink is greyed out until another is added, and the page says the email code still works either way.'
	);
	await waitForNarration(page);

	// Row 10
	await page.goto(conversationUrl, { waitUntil: 'load' });
	await expect(page.getByText(QUESTION).first()).toBeVisible({ timeout: 15_000 });
	await narrate('Last, logging out, from the same account menu.');
	await click(accountButton(page));
	await click(page.getByRole('menuitem', { name: 'Log out' }));
	await expect(accountButton(page)).toHaveAccessibleName('Account — guest', { timeout: 15_000 });
	await page.goto(conversationUrl, { waitUntil: 'load' });
	await expect(page.getByText(QUESTION)).toHaveCount(0, { timeout: 15_000 });
	await narrate(
		"The rail says Guest again, and that conversation's address no longer shows Sam's chat to whoever uses this browser next."
	);
	await waitForNarration(page);
	await narrate('That is A1: try it first, and sign in when you want it to remember you.');
	await waitForNarration(page);
});
