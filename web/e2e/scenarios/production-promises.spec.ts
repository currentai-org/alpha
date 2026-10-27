// e2e-product: @chat @site
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { phrase } from './helpers/text';
import { journeyStep } from './helpers/journeyStep';
import { accountButton } from './helpers/accountMenu';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { startChattingPastWelcome } from './helpers/welcome';

// The promises A3 ("My data stays mine") and A5 ("I can report what is wrong") make to a guest,
// checked where they are made: on production's chat host (alpha since CUR-4439, chat at its root), every
// four hours, by the live suite (CUR-2619).
//
// WHY A SEPARATE FILE RATHER THAN TAGGING THE JOURNEY SPECS @live. Those specs are written for a
// develop preview, and two of them assert things production does not offer: `report-a-problem.spec.ts`
// expects six report reasons where production has four (refused and language are develop-only), and
// it submits a report, which on www would land a real one in the team's queue. This file asserts only
// what production promises today, and touches nothing it cannot take back.
//
// ONE CHAT TURN, AND IT CLEANS UP AFTER ITSELF. The live suite budgets one turn per run on
// production's model pool (scenario-suite-live.yml); this is the second, and it is the only turn that
// leaves no conversation behind: the guest erases it with "Forget everything" at the end, which is
// itself the promise under test.
//
// NO JOURNEY TAG. The gallery grades a journey's step table against recordings tagged with its letter.
// This walk visits two journeys' steps out of their order, so tagging it @A3 or @A5 would hand the
// grader a recording that skips steps it never set out to walk.
//
// MARKED AS INTERNAL TRAFFIC. `?ph_test=live-suite` registers PostHog's `is_internal_test` and
// `tester` super-properties (analytics.ts `internalTrafficProps`), so a PostHog filter can drop these
// runs' browser events from production's visitor numbers. Server-side events carry no such mark.
const liveEntry = () => `${chatEntry()}?ph_test=live-suite`;

test(
	'a guest on this deployment is told about the 30-day clock, can find how to report an answer, and can erase everything',
	{ tag: '@live' },
	async ({ page }) => {
		// Step 1 waits on a real generation; everything after it is page navigation.
		test.setTimeout(180_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(liveEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		const reportButton = page.getByRole('button', { name: 'Report this answer' }).first();
		const assistantMessage = page.locator('[data-message-role="assistant"]').last();
		await journeyStep(page, 'A5', 1, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name one river in Switzerland in one short sentence.');
			await composer.press('Enter');
			await page.waitForURL(new RegExp(`${chatPath('/conversation/')}[a-f0-9]+`), {
				timeout: 30_000
			});

			// The per-answer report control mounts only under a completed answer (report-a-problem.spec.ts
			// says why that makes it the "an answer arrived" signal), so this is also the wait for the turn.
			await expect(
				reportButton,
				'no completed answer with a report control appeared within 90s: either the reply never finished or this build no longer puts "Report this answer" on the answer'
			).toBeVisible({ timeout: 90_000 });
			await expect(
				assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true })
			).toBeVisible({ timeout: 45_000 });
		});

		// A3: once a guest's conversation exists, a note says it is deleted after 30 days idle.
		await journeyStep(page, 'A3', 2, async () => {
			await expect(
				page.getByText(/30 days/i).first(),
				'a guest with a conversation is never told it is deleted after 30 days idle'
			).toBeVisible({ timeout: 15_000 });
		});

		// A5: the answer itself offers plain-language reasons to report it. These four are the ones
		// production offers; develop adds more, so this asserts a floor of named reasons, not a count.
		const menu = page.getByRole('menu');
		await journeyStep(page, 'A5', 3, async () => {
			await reportButton.click();
			await expect(menu, 'the report control opened no menu of reasons').toBeVisible({
				timeout: 10_000
			});
			for (const label of [
				'Harmful or unsafe',
				'Inaccurate or misleading',
				'Privacy or copyright',
				'Something else'
			]) {
				await expect(
					menu.getByRole('menuitem', { name: label }),
					`the report menu does not offer "${label}"`
				).toBeVisible({ timeout: 5_000 });
			}
		});
		// Picking a reason would file a real report on www, so the menu closes unpicked.
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden({ timeout: 5_000 });

		// A3: the way out is one tap from the chat, and it erases in two deliberate steps.
		await journeyStep(page, 'A3', 3, async () => {
			await page.getByRole('button', { name: 'Where your message goes' }).click();
			await page.getByRole('link', { name: 'Data & privacy' }).click();
			await page.waitForURL(/\/settings\/data/, { timeout: 30_000 });
		});
		await journeyStep(page, 'A3', 4, async () => {
			await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 10_000 });
			await expect(
				page.getByRole('heading', { name: 'Forget everything?' }),
				'"Forget everything" erased without asking first'
			).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(phrase('This action cannot be undone'))).toBeVisible();
		});
		// The promise is a second, deliberate step, not its label: production's build says "Delete all"
		// where develop's says "Forget everything", and both sit beside a focused Cancel.
		await journeyStep(page, 'A3', 5, async () => {
			await page
				.getByRole('dialog')
				.getByRole('button', { name: /^(Forget everything|Delete all)$/ })
				.click();
			await expect(
				page.getByRole('heading', { name: 'Your data has been cleared' }),
				'confirming "Forget everything" never said the data was cleared'
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText('1 conversation')).toBeVisible({ timeout: 15_000 });
		});
		await page.getByRole('button', { name: 'Done' }).click();

		// Erased on the server, not hidden on the page: a fresh load shows no trace of the question.
		await page.goto(liveEntry(), { waitUntil: 'commit' });
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByText('Name one river in Switzerland'),
			'the erased conversation is still there after a reload'
		).toHaveCount(0);
	}
);

// A6 and A1, on one turn. The guest pastes a document into the message box and asks about a detail
// only the document holds (A6: "paste a long document's text, and Alpha answers from it"), then signs
// in from inside that conversation (A1: the five ways in are offered; the guest's conversation comes
// along and they land back in it; the rail names them; the account page shows their email and a way
// to add another sign-in).
//
// ON WWW IT SIGNS IN AS ONE STANDING ACCOUNT, never a new one per run. Sign-ups are off (CUR-2050) in
// production's run. The workflow hands over the sign-in probe's @example.org address with `+live-suite`
// added (Resend never mails that domain) as LIVE_SIGNIN_EMAIL. It is a separate address because each
// send voids the previous code, so sharing the probe's would let the two runs break each other. On any
// other target a fresh @example.org address is minted, as every preview spec does. The conversation is
// deleted at the end, so the account does not collect one every four hours.
// alpha is production's chat host (CUR-4439); www still counts so a run pointed there stays guarded.
const PRODUCTION_HOSTS = ['www.aipotluck.org', 'alpha.aipotluck.org'];

test(
	'a guest can paste a document and get an answer from it, then sign in from that conversation and keep it',
	{ tag: '@live' },
	async ({ page, baseURL }) => {
		test.setTimeout(180_000);
		const onProduction = PRODUCTION_HOSTS.includes(new URL(baseURL!).host);
		const email = process.env.LIVE_SIGNIN_EMAIL || (onProduction ? '' : freshTestEmail());
		expect(
			email,
			'LIVE_SIGNIN_EMAIL is unset on production: this test must sign in as its standing account, not sign up a new one each run'
		).not.toBe('');
		const databaseUrl = process.env.SCENARIO_DATABASE_URL!;

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		// `load`, not `commit`: the nav renders twice and only CSS hides one (sign-in.spec.ts, CUR-1479).
		await page.goto(liveEntry(), { waitUntil: 'load' });
		await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
			timeout: 15_000
		});

		// A6. The one detail the question needs is in the pasted text and nowhere else.
		const notice = [
			'Lindenhof Community Garden — autumn notice to members.',
			'Composting moves to the north bed from October. Bring your own gloves; the shared pairs are being washed.',
			'The tool shed now opens at 07:40 on Saturdays, and stays closed on Sundays until spring.',
			'Water butts will be drained at the end of the month, so please plan watering around that.',
			'Seed swap: the table by the gate holds envelopes; label anything you leave with the variety and year.'
		].join('\n\n');
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			`${notice}\n\nAccording to the notice above, what time does the tool shed open on Saturdays?`
		);
		await composer.press('Enter');
		await page.waitForURL(new RegExp(`${chatPath('/conversation/')}[a-f0-9]+`), {
			timeout: 30_000
		});
		const conversationUrl = page.url();
		const conversationId = new URL(conversationUrl).pathname.split('/').pop()!;

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			answer.getByRole('button', { name: 'Copy to clipboard', exact: true })
		).toBeVisible({ timeout: 90_000 });
		await expect(
			answer,
			'the answer does not give the time the pasted notice states (07:40), so it did not answer from the document'
		).toContainText(/\b0?7[:.]40\b/);

		// A1. The way in is offered five ways side by side.
		await page.goto(chatPath('/login'), { waitUntil: 'load' });
		for (const name of [
			'Continue with email',
			'Continue with Google',
			'Continue with GitHub',
			'Continue with Hugging Face',
			/^Use a passkey/
		]) {
			await expect(
				page.getByRole('button', { name }),
				`the sign-in screen does not offer "${name}"`
			).toBeVisible({ timeout: 15_000 });
		}

		// From inside the conversation: sign in, land back in it, and find the question still there.
		await page.goto(conversationUrl, { waitUntil: 'load' });
		await signInWithEmailOtp(page, databaseUrl, email, {
			viaNavLink: true,
			landsOn: new RegExp(`${chatPath('/conversation/')}${conversationId}`),
			skipPendingLabelCheck: true
		});
		await expect(
			page.getByText('what time does the tool shed open on Saturdays').first(),
			'the conversation started as a guest is not there after signing in'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			accountButton(page),
			'nothing names the account once signed in'
		).toHaveAccessibleName(/signed in as /i, { timeout: 15_000 });

		await page.goto(chatPath('/settings/account'), { waitUntil: 'load' });
		await expect(
			page.getByTestId('account-email'),
			'the account page does not show the signed-in email'
		).toContainText(email, { timeout: 15_000 });
		await expect(
			page.getByRole('button', { name: /^Add a passkey/ }),
			'the account page offers no way to add another sign-in'
		).toBeVisible();

		// Leave the standing account as it was found.
		const status = await page.evaluate(
			async (id) => (await fetch(`/chat/api/v2/conversations/${id}`, { method: 'DELETE' })).status,
			conversationId
		);
		expect(status, "cleanup: deleting this run's conversation failed").toBeLessThan(300);
	}
);

test(
	'the privacy notice on this deployment tells a person where to write to exercise their rights',
	{ tag: '@live' },
	async ({ page }) => {
		await page.goto('/privacy-notice', { waitUntil: 'domcontentloaded' });
		await expect(
			page.getByText('legal@currentai.org').first(),
			'the privacy notice names no address to write to (legal@currentai.org)'
		).toBeVisible({ timeout: 30_000 });
	}
);
