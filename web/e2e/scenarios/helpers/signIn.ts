import { expect, type Locator, type Page } from '@playwright/test';
import { readSignInOtp } from './otp';
import { accountMenuItem } from './accountMenu';
import { journeyStep } from './journeyStep';

// After a successful verify (CUR-1481), `busy` clearing can re-enable the Verify button and
// revert its label to "Verify" for up to ~2.3s before the redirect landed — indistinguishable on
// screen from a code that had never been accepted. waitForURL alone can't see this: the URL
// doesn't change until well after that window closes. Waits for the button to first show its
// pending label (proof the auto-submit effect actually started — not the moment just after the 6th
// digit lands, where an enabled "Verify" is the correct pre-submission state), then polls until
// navigation to catch it coming back.
//
// The pending label is "Signing you in…" and has to be read off +page.svelte rather than
// remembered: an assertion that names a stale label cannot pass in any state (CUR-1487).
// Injuring the fix does not catch that: the assertion is red either way,
// which satisfies "can it go red" and proves nothing. A gate has to go red for the failure it
// NAMES. The label covers both `busy === "verify-otp"` and the `verifiedCode` window after busy
// clears (+page.svelte:241-244), so it shows when the old one did and lasts strictly longer.
async function assertVerifyButtonStaysPendingUntilNav(page: Page): Promise<void> {
	const pending = page.getByRole('button', { name: 'Signing you in…', exact: true });
	await expect(pending).toBeVisible({
		timeout: 5_000
	});
	// The label must not sit perfectly still for the whole wait (CUR-1621). Something in the button has
	// to be moving, so read the spinner's running animation rather than its presence in the DOM.
	// Skipped under reduced motion, where the spinner deliberately stands still.
	const seen = await pending
		.locator('[data-signing-in-spinner] *')
		.evaluateAll((els) => ({
			cells: els.length,
			moving:
				window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
				els.some((el) => getComputedStyle(el).animationName !== 'none')
		}))
		.catch(() => ({ cells: 0, moving: false }));
	// A redirect fast enough to unmount the button between the two reads says nothing either way (the
	// CUR-1696 race); a button still on screen with nothing moving in it is the defect.
	const stillPending = /\/login/.test(page.url()) && (await pending.isVisible().catch(() => false));
	if (stillPending || seen.cells > 0) {
		expect(seen.moving, 'the pending sign-in button shows no moving indicator').toBe(true);
	}

	// An enabled "Verify" reappearing has two causes that look identical to this poll —
	// the CUR-1481 timing regression (code WAS accepted, the UI just lagged), and a genuine
	// rejection (the code was wrong, or +page.svelte's own errorMsg alert fired). Both leave the
	// button enabled and labelled "Verify"; only the alert distinguishes them. Checking it first
	// turns a misleading "CUR-1481 regression" on a real rejection into the actual cause (CUR-1493).
	// A "Too many requests. Please try again
	// later." alert can sit in the DOM while the button behaves correctly.
	// The send cap (CUR-1486) has a carve-out (CUR-1553), so this suite's own sends no
	// longer hit it, so a "Too many requests" surfacing HERE (post-submit) would be a different,
	// still-active per-path limiter on the verify step itself, not the send one.
	const errorAlert = page.getByRole('alert');
	const enabledVerify = page.getByRole('button', { name: 'Verify and sign in', exact: true });
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline && !/\/chat\/?(\?|$)/.test(page.url())) {
		if (
			(await enabledVerify.isVisible().catch(() => false)) &&
			(await enabledVerify.isEnabled().catch(() => false))
		) {
			if (await errorAlert.isVisible().catch(() => false)) {
				const alertText = await errorAlert.innerText().catch(() => '(could not read alert text)');
				throw new Error(
					`OTP verify was rejected, not a CUR-1481 regression: the page shows "${alertText}". The Verify ` +
						'button correctly re-enabled — check the rejection itself (the send cap no longer applies ' +
						"to this suite per CUR-1553, so a rate-limit message here is the verify step's own limiter)."
				);
			}
			throw new Error(
				'CUR-1481 regression: the Verify button returned to an enabled "Verify" state — indistinguishable ' +
					'from an unsubmitted code — after the code was already accepted, before the redirect landed.'
			);
		}
		await page.waitForTimeout(50);
	}
}

// When the send is refused, +page.svelte sets `errorMsg` and renders it in a role="alert"
// banner — so the reason is on screen, in an element with a role, a full 15s before a bare
// `#signin-otp` wait gives up. Reporting only "the OTP screen never appeared" sends people chasing
// flaky infrastructure while the page reads "Too many requests. Please try again later."
// Poll for either outcome and quote whichever one the page actually produced.
//
// A manual poll rather than locator.or(): `toBeVisible` on a locator matching two elements is a
// strict-mode violation if a stale banner is ever on screen beside the field, and a helper whose whole
// job is legible failures should not introduce a new way to fail. The login page renders exactly one
// role="alert" and the layouts above it render none, so the banner locator is unambiguous.
async function bannerText(banner: Locator): Promise<string | null> {
	if (!(await banner.isVisible().catch(() => false))) return null;
	const text = (await banner.textContent().catch(() => null))?.trim();
	return text ? text : null;
}

// The deadline is a parameter rather than a constant in the body: it is a property of this wait that a
// caller might reasonably tune, and in the signature a reader sees it without reading the loop. It is
// also what `scripts/e2e-scope-classify.mjs` counts — it reads literal `timeout: N` occurrences, so a
// deadline expressed only as `Date.now() + N` reads to it as coverage removed (CUR-1494).
async function waitForOtpScreen(
	page: Page,
	opts: { timeout: number } = { timeout: 15_000 }
): Promise<void> {
	const otpField = page.locator('#signin-otp');
	const banner = page.getByRole('alert');
	const deadline = Date.now() + opts.timeout;

	while (Date.now() < deadline) {
		if (await otpField.isVisible().catch(() => false)) return;
		const said = await bannerText(banner);
		if (said) {
			throw new Error(
				`the OTP screen never appeared because the send was refused. The page says: "${said}" ` +
					'(+page.svelte renders this from errorMsg; CUR-1486 named the per-IP send cap behind ' +
					'"Too many requests" — CUR-1553\'s carve-out should make this suite immune to it, so seeing ' +
					'it here likely means the bypass secret is unset or unsynced in this environment).'
			);
		}
		await page.waitForTimeout(100);
	}

	// Deadline hit. Whether a banner is present is itself the distinguishing fact: one means the send
	// was refused and we simply raced it, none means the request neither succeeded nor was rejected.
	const said = await bannerText(banner);
	throw new Error(
		said
			? `the OTP screen never appeared within ${opts.timeout}ms. The page says: "${said}".`
			: `the OTP screen never appeared within ${opts.timeout}ms, and the page showed no error either — so the send ` +
					"neither completed nor was refused. Read the trace's network activity rather than assuming a " +
					'rate limit; a refusal would have rendered a banner.'
	);
}

/** No allowlist, no pre-seeded account needed (betterAuth.ts has no email-domain check, and the
 *  "sign-in" OTP type always allows account creation). One per call — never reused. In CI the
 *  address carries the run id, so cleanup-e2e-artifacts.mjs `--run` deletes this run's accounts and
 *  no other run's still in use on the same database. `domain` is for a spec that needs a staff
 *  domain a flag targets ; the cleanup script knows both. Only example.org gets the
 *  OTP send-cap carve-out, so a staff-domain address must sign in with signInAsFreshUser's cookies. */
export function freshTestEmail(domain: 'example.org' | 'currentai.org' = 'example.org'): string {
	const run = process.env.GITHUB_RUN_ID;
	return `e2e-${run ? `r${run}-` : ''}${crypto.randomUUID()}@${domain}`;
}

// Better Auth's built-in email-otp rate limiter caps /email-otp/send-verification-otp at
// 3 requests per 60s, keyed on (ip, path) — betterAuth.ts's otpSendCapCarveOut now skips that cap
// entirely for this suite's own traffic (playwright.config.ts sends the required header on every
// request, and freshTestEmail() below always mints an @example.org target), so there is no longer
// a real limit here to sleep ahead of. so there is no client-side throttle mirroring
// the server's decideConsume algorithm: a throttle nothing can trip is dead code that would
// mislead the next reader into thinking a real limit still applies here (CUR-1553).

// The two Better Auth paths otpSendCapCarveOut reads this header on — send AND this app's
// real verify call (signIn.emailOtp() -> POST /sign-in/email-otp, not /email-otp/check-verification-otp).
// Scoped via page.route() rather than Playwright's global `use.extraHTTPHeaders` (playwright.config.ts
// does not set it): a header sent on every request forces a CORS preflight on cross-origin ones,
// and fonts.gstatic.com doesn't allow this custom header, so a global header would break font loading and
// fail an unrelated console-error check. Routing it per-path means nothing else on
// the page ever sees it.
const OTP_BYPASS_PATHS = new Set([
	'/chat/api/auth/email-otp/send-verification-otp',
	'/chat/api/auth/sign-in/email-otp'
]);

export async function installOtpBypassHeader(page: Page): Promise<void> {
	const token = process.env.E2E_OTP_BYPASS_TOKEN;
	if (!token) return;
	const base = process.env.SCENARIO_BASE_URL;
	await page.route(
		(url) => (!base || url.origin === new URL(base).origin) && OTP_BYPASS_PATHS.has(url.pathname),
		(route) =>
			route.continue({ headers: { ...route.request().headers(), 'x-e2e-otp-bypass': token } })
	);
}

export async function signInWithEmailOtp(
	page: Page,
	databaseUrl: string,
	email: string,
	options: { viaNavLink?: boolean; landsOn?: RegExp; skipPendingLabelCheck?: boolean } = {}
): Promise<void> {
	await installOtpBypassHeader(page);
	if (options.viaNavLink) {
		// The real entry point (the account menu's "Log in") rather than a goto shortcut around it —
		// for a test proving the sign-in confirmation replaces it (CUR-432).
		// The row ends on the open menu showing "Log in", so its snapshot is the menu, not the dialog
		// the click opens (CUR-2764).
		const logIn = await journeyStep(page, 'A1', 3, () =>
			accountMenuItem(page, 'Log in', { timeout: 20_000 })
		);
		await logIn.click();
	} else {
		await page.goto('/chat/login');
	}
	// Rows 5 and 6 of a1-sign-in.md, marked so the A1 tour can cut them out of any sign-in.
	await journeyStep(page, 'A1', 5, async () => {
		await page.locator('#signin-email').fill(email);
		await page.getByRole('button', { name: 'Continue with email' }).click();

		// Wait for +page.svelte's own client-side transition to the "Enter the code" screen before
		// touching the database — this turns "the send itself never completed" into its own clear
		// timeout here, instead of surfacing as an opaque "no verification row after 5s" from
		// readSignInOtp that can't distinguish a failed send from a merely slow one.
		// It also reports the banner's text when there is one, rather than only that the field
		// never showed up.
		await waitForOtpScreen(page);

		// The screen's own confirmation that a code was sent, and where — +page.svelte's "Enter the
		// code we sent to {email}." A viewer of the recording sees this text; the element check above
		// only proves the input exists. Without it, a real visitor's only signal that clicking "Continue
		// with email" did anything is the field itself appearing, which is exactly what step 4 of
		// a1-sign-in.md calls broken.
		await page.getByText(`We sent a 6-digit code to ${email}.`).waitFor({ state: 'visible' });
	});

	await journeyStep(page, 'A1', 6, async () => {
		const otp = await readSignInOtp(databaseUrl, email);
		await page.locator('#signin-otp').fill(otp);
		// Auto-submits at 6 digits (+page.svelte's own effect) — no click on "Verify" here proves step
		// 5's own bar: the code goes through the moment the sixth digit lands, with no separate button.
		// Where sign-in lands is a property of the flow, so a caller that drove a flow with a
		// different landing has to be able to say so. The default is the chat entry, which is where
		// `login/+page.svelte` sends anyone whose `next` was absent or rejected.
		// A caller who clicked "Log in" from inside a conversation passes that conversation's
		// URL, and a helper that kept waiting for the entry would go red on the fix rather than on a
		// defect.
		// assertVerifyButtonStaysPendingUntilNav's own 5s window on the pending label races a
		// genuinely-fast redirect and loses (CUR-1696), landing
		// fully signed in before the check sees the transient state. That
		// race belongs to CUR-1481/CUR-1487, and a passkey test only needs "did the OTP leg land signed
		// in" — it has no stake in whether the pending label rendered on schedule.
		// The window is not loosened here, since a looser timing
		// assumption for every caller risks masking the exact regression CUR-1487 was written to catch.
		const landed = page.waitForURL(options.landsOn ?? /\/chat\/?(\?|$)/, { timeout: 15_000 });
		if (options.skipPendingLabelCheck) {
			await landed;
		} else {
			await Promise.all([landed, assertVerifyButtonStaysPendingUntilNav(page)]);
		}
	});
}
