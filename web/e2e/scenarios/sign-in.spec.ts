// e2e-product: @chat
// e2e-area: @auth
import { test, expect, type Locator } from './helpers/test';
import { freshTestEmail, installOtpBypassHeader, signInWithEmailOtp } from './helpers/signIn';
import { CHAT_ENTRY, chatEntry } from './helpers/chatEntry';
import { phrase } from './helpers/text';
import { turnDone } from './helpers/turn';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { watchForChatLanding, watchForSelector } from './helpers/landingWatch';
import { journeyStep } from './helpers/journeyStep';
import { expireSignInOtp, readSignInOtp } from './helpers/otp';
import { installCannedReplies } from './helpers/faultInjection';
import { composerHydrated } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';

// global-setup.ts already asserts this is set before any test body runs — no module-scope throw
// here, since a static tool (knip's Playwright plugin) importing this file to collect tests would
// break on one.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

test.describe('email-OTP sign-in', () => {
	// Chat-ui's own Hugging Face redirect used to answer any GET of /chat/login that did not
	// negotiate text/html (a bare fetch, a probe), which is how a plain curl landed on Hugging Face's
	// login page and read as though the chooser had never shipped (CUR-1961). It is gone, and the flag that kept it
	// as a fallback with it. A non-browser request now gets the same chooser page a browser does.
	test(
		'a non-browser GET of the sign-in page answers the chooser, not a redirect to Hugging Face',
		{ tag: '@A1' },
		async ({ request, page }) => {
			const res = await request.get('/chat/login', {
				maxRedirects: 0,
				headers: { accept: '*/*' },
				timeout: 15_000
			});
			expect(
				res.headers()['location'] ?? '',
				'the legacy chat-ui login redirected every non-browser GET to huggingface.co/oauth/authorize'
			).not.toMatch(/huggingface\.co/);
			expect(res.status()).toBe(200);
			expect(await res.text()).toContain('Sign in to Alpha');

			// The browser gets the same chooser, with no override cookie set.
			await page.goto('/chat/login');
			await expect(page.getByRole('heading', { name: 'Sign in to Alpha' })).toBeVisible({
				timeout: 15_000
			});
		}
	);

	// CUR-1133 / CUR-3157: disableImplicitLinking (betterAuth.ts) refuses a sign-in through a second
	// provider on an address that already has an account (betterAuth.accountMerge.spec.ts), so a provider
	// is added by linking it in Settings while signed in, and an email code opens whichever account uses
	// that address. The chooser says both, so nobody avoids the email code for fear of a fresh account.
	// `phase` defaults to `"chooser"`, so the plain goto lands on the copy without driving a provider.
	test(
		'the chooser page says an email code opens the existing account and that providers are linked after signing in',
		{ tag: '@A1' },
		async ({ page }) => {
			await page.goto('/chat/login', { waitUntil: 'load' });
			await expect(
				page.getByText('An email code opens the account that uses that address.', { exact: false }),
				'the chooser should say an email code opens the existing account for that address, not a new one'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.getByText(
					'To add Google, GitHub or Hugging Face as another way in, sign in first, then link it in Settings.',
					{ exact: false }
				),
				'the chooser should say a provider is added by linking it while signed in'
			).toBeVisible();
		}
	);

	// The critique loop saw 'Continue with email' dim at first load and bright over the same
	// empty field later, and read the bright one as a button that does nothing (CUR-3392). It is dim only until
	// hydration (CUR-1400); after that it stays enabled on purpose, so a click says why it cannot send
	// (CUR-1064). This drives that click.
	test(
		'Continue with email on an empty field says to enter an address and stays on the chooser (CUR-3392)',
		{ tag: '@A1' },
		async ({ page }) => {
			await page.goto('/chat/login', { waitUntil: 'load' });
			const send = page.getByRole('button', { name: 'Continue with email' });
			await expect(send, 'the button should be enabled once the page has hydrated').toBeEnabled({
				timeout: 15_000
			});
			await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
			await send.click();
			await expect(
				page.getByText('Enter your email address.'),
				'a click on an empty field should say what is missing, not do nothing'
			).toBeVisible();
			await expect(page).toHaveURL(/\/chat\/login/);
			await expect(page.getByRole('heading', { name: 'Sign in to Alpha' })).toBeVisible();
		}
	);

	// The graded A1 board saw Google, GitHub and Hugging Face as bordered buttons and passkey
	// as plain grey text under them, which read as a caveat rather than a fifth way in (CUR-2468). Passkey now sits
	// in the same group with the same button styling, and this compares what a person actually sees.
	test(
		'the passkey route is drawn as an equal button beside the other providers, not as a text link',
		{ tag: '@A1' },
		async ({ page }) => {
			await page.goto('/chat/login', { waitUntil: 'load' });
			const passkey = page.getByRole('button', { name: /^Use a passkey/ });
			const provider = page
				.getByRole('button', { name: /^Continue with (Google|GitHub|Hugging Face)$/ })
				.first();
			await expect(passkey).toBeVisible({ timeout: 15_000 });
			await expect(provider, 'no OAuth provider button to compare passkey against').toBeVisible();

			const look = (button: typeof passkey) =>
				button.evaluate((el) => {
					const s = getComputedStyle(el);
					return {
						border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
						background: s.backgroundColor,
						height: Math.round(el.getBoundingClientRect().height),
						group: el.parentElement === null ? null : el.parentElement.className
					};
				});
			const [p, o] = [await look(passkey), await look(provider)];
			expect(p.border, 'passkey has no border of its own').not.toMatch(/^0px|none/);
			expect(p, 'passkey is drawn differently from the provider buttons beside it').toEqual(o);
		}
	);

	// With no guest conversation to carry, the new-chat landing is where sign-in should end,
	// so it is expected here (CUR-1808). What would read as a flash is the landing painting on some other page
	// first and the view then moving on, so the landing must have painted on the page sign-in settled on
	// and nowhere else.
	test(
		'a brand-new visitor can sign in end to end with a real emailed OTP',
		{ tag: '@A1' },
		async ({ page }) => {
			const landingSightings = await watchForChatLanding(page);
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail());
			await expect(page).toHaveURL(/\/chat\/?(\?|$)/);

			const settledOn = new URL(page.url()).pathname;
			await expect
				.poll(() => [...new Set(landingSightings)], {
					message:
						'after the code was accepted, the new-chat landing painted on a page other than the one sign-in settled on',
					timeout: 15_000
				})
				.toEqual([settledOn]);
		}
	);

	// Production and develop both wrote Better Auth's default-named session cookie on
	// Domain=aipotluck.org, so signing in on one overwrote the other's cookie and signed the person out
	// there (CUR-1904). This reads the cookie a real sign-in actually set on this preview. It has to carry a name
	// production never uses and no Domain attribute, or a sign-in here can still reach production.
	// @preview-only: production is the one deployment that keeps the default name and the apex Domain.
	test(
		"a preview's session cookie has its own name and no Domain, so signing in here cannot sign anyone out of production",
		{ tag: ['@A1', '@preview-only', '@CUR-1904'] },
		async ({ page, context, baseURL }) => {
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail());
			await expect(page).toHaveURL(/\/chat\/?(\?|$)/);

			const session = (await context.cookies(baseURL!)).find((c) =>
				c.name.endsWith('.session_token')
			);
			expect(
				session,
				'a completed sign-in should leave a Better Auth session cookie on this host'
			).toBeTruthy();
			expect(
				session!.name,
				"the preview's session cookie must not share production's name (better-auth.session_token)"
			).not.toMatch(/(^|-)better-auth\.session_token$/);
			expect(
				session!.domain,
				'a leading dot means the cookie was set with a Domain attribute and reaches every sibling host'
			).not.toMatch(/^\./);
		}
	);

	// The point of signing in ("A1 (CUR-849). I can try Alpha, and sign in when I want it to remember
	// me") is that it remembers you. The test above stops at a completed sign-in; this one follows
	// through to what that sign-in was supposed to buy. Before this fix, signing in silently orphaned
	// every anonymous conversation
	// (userId stayed unset, sidebar came back empty, the old URL redirected to a blank chat with no
	// explanation). migrateAnonymousConversations (migrateAnonymousSession.ts) re-keys every
	// conversation matching the pre-sign-in sessionId onto the new user, which is why this drives a
	// real conversation through the SAME page/context before signing in — a fresh context would carry
	// no sessionId for the migration to key off, and could pass with the migration silently broken.
	// 180s, the same budget report-a-problem.spec.ts:108 carries for the same 90s answer wait. The
	// suite default is 90s, which is exactly that wait — so the budget would kill this test before
	// the wait could reach its own deadline, and the message below would only ever be printed by a
	// budget death describing what its author guessed (check:scenario-budgets, CUR-1633).
	test(
		'signing in carries an anonymous conversation onto the account, not just the redirect',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(180_000);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await installCannedReplies(page);
			// The control for the CUR-3116 assertion at the bottom: the turn before sign-in really is
			// computing for a moment, so this watch has to see a live line there. Without it, a selector
			// that drifted or a watch that never fires would pass that assertion exactly as a fix would.
			const liveLinesBeforeSignIn = await watchForSelector(
				page,
				'[data-live-line]',
				'__liveLineControl'
			);

			// Set before the page loads so the rail renders its "Log in" link, which is how this test
			// reaches sign-in below.
			const { conversationUrl, answerBeforeSignIn } = await journeyStep(page, 'A1', 2, async () => {
				await page.goto(chatEntry(), { waitUntil: 'commit' });
				const composer = page.getByLabel('Message AI Potluck');
				await composer.click({ timeout: 30_000 });
				await composer.fill('Name one lake in Switzerland in one short sentence.');
				await composer.press('Enter');
				await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

				const conversationUrl = page.url();

				// Wait for a real, finished answer BEFORE signing in (CUR-1668). Until this landed, the
				// test went straight from the URL appearing to the sign-in, which takes a second or two
				// — so the recording the journey grader watches showed `Apertus 1.5 70B is working…` and
				// never anything else, and the assertion at the bottom passed anyway because it reads
				// back the user's own question.
				//
				// That is the gap this closes, and it is a1-sign-in.md's own row 2 ("a streamed reply
				// appears" / "it feels broken if the composer locks up with no reply") plus "What good
				// looks like" ("a person is already inside Alpha and already has a real answer sitting in
				// front of them"). The promise was written down; nothing checked it.
				//
				// Both waits: Retry marks the turn as finished, where a copy button can show while it is
				// still working (CUR-1652, CUR-2133), and the `.prose` body is what proves words exist.
				// 90s matches the budget report-a-problem.spec.ts uses for the same precondition on the
				// same preview tier.
				const assistantMessage = page.locator('[data-message-role="assistant"]').last();
				const answerBody = assistantMessage.locator('.prose');
				await expect(
					turnDone(assistantMessage),
					'no completed-answer control appeared within 90s, so this test never reached the thing it is named after. Read the attached snapshot for an assistant bubble: a bubble stuck on a status line is CUR-1667 (the stream going quiet mid-generation), while no bubble at all is a send that never landed'
				).toBeVisible({ timeout: 90_000 });
				await expect(answerBody).toBeVisible({ timeout: 15_000 });

				const answerBeforeSignIn = (await answerBody.allInnerTexts()).join('\n').trim();
				// Guard the guard: an empty `.prose` is visible, and asserting on "" below would pass
				// against a blank bubble forever. A real one-sentence reply clears this by a wide margin.
				expect(
					answerBeforeSignIn.length,
					`the answer body rendered but held ${answerBeforeSignIn.length} characters, so there is nothing for sign-in to carry`
				).toBeGreaterThan(20);
				expect(
					liveLinesBeforeSignIn.length,
					'the turn before sign-in never rendered a live line, so the CUR-3116 watch below cannot see one either'
				).toBeGreaterThan(0);
				return { conversationUrl, answerBeforeSignIn };
			});

			// The journey critic saw the new-chat landing flash for a frame between the code
			// being accepted and this conversation coming back, which reads as the conversation being
			// lost (CUR-1594). The watcher sees every frame of every document from here on (helpers/landingWatch.ts).
			const landingSightings = await watchForChatLanding(page);
			// One graded run saw this finished answer come back as "<model> is computing…" after
			// the code was accepted, then turn back into the answer (CUR-3116). The answer was complete before sign-in
			// and nothing is sent after it, so no document from here on should render an unfinished live
			// line (`data-live-line`, LiveRequestLog.svelte) at all.
			const liveLineSightings = await watchForSelector(page, '[data-live-line]', '__liveLineSeen');

			// Through the rail's "Log in", as a person would. It carries `next` (CUR-1673), so sign-in
			// lands back on this conversation by itself. A bare /chat/login would land on the chat entry first,
			// and the entry screen that flashed in between read as a defect (CUR-1578).
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), {
				viaNavLink: true,
				landsOn: new RegExp(`${new URL(conversationUrl).pathname}$`)
			});

			// The regression's own failure mode was a SILENT redirect to a blank new chat — reading the
			// URL back, not just the message text, is what would have caught it: a migration that failed
			// sends this to /chat instead of back to the same conversation.
			await journeyStep(page, 'A1', 8, async () => {
				await expect(page).toHaveURL(conversationUrl);
				await expect(
					page.getByText('Name one lake in Switzerland in one short sentence.')
				).toBeVisible({ timeout: 15_000 });

				// And the ANSWER survives, not just the question (CUR-1668). A migration that carried the
				// conversation row but lost its assistant message would pass every assertion above this
				// one. Matched on the text captured before sign-in rather than on "some answer is
				// present", because that is the claim — the same answer, untouched.
				// Whitespace-collapsed before slicing: `toContainText` normalizes runs of whitespace on the
				// page side, so an un-normalized needle carrying a newline from the first read would fail
				// to match text that is in fact identical. A wrapped line is not a lost answer.
				const answerNeedle = answerBeforeSignIn.replace(/\s+/g, ' ').slice(0, 40);
				await expect(
					page.locator('[data-message-role="assistant"]').last().locator('.prose'),
					'the conversation came back without the answer that was on screen before sign-in'
				).toContainText(answerNeedle, { timeout: 15_000 });
			});

			expect(
				landingSightings,
				'after the code was accepted, the new-chat landing rendered before this conversation came back'
			).toEqual([]);
			expect(
				liveLineSightings,
				'after the code was accepted, the finished answer rendered as still being computed (CUR-3116)'
			).toEqual([]);
		}
	);

	// The CUR-849 test above proves migration on a FIRST login (CUR-1719). This one proves the gap CUR-849
	// left standing: `auth.ts`'s migration calls used to sit entirely inside `if (!user)` — a returning
	// user (the shadow user row already exists) got nothing migrated, so a person who signs out, goes
	// anonymous in the same browser, has a conversation, then signs back in lost it silently, the exact
	// same "silent orphan" CUR-849 fixed for the first-login case. `migrateAnonymousConversations`'s
	// docstring calls this exact case ("keyed strictly by sessionId") safe already — `auth.ts` simply
	// never called it here. Drives a real sign-out between the two logins rather
	// than asserting on the code path directly, for the same reason the CUR-849 test drives a real
	// conversation: a passing assertion on the function in isolation cannot prove `auth.ts` actually
	// reaches it from the returning-login branch.
	test(
		'a returning user who goes anonymous again in the same browser still keeps that conversation on sign-in',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(180_000);
			const databaseUrl = process.env.SCENARIO_DATABASE_URL;
			if (!databaseUrl)
				throw new Error(
					'SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this'
				);
			const email = freshTestEmail();
			// The welcome covers the whole app, rail included, so the account menu waits for it to close.
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});

			await signInWithEmailOtp(page, databaseUrl, email);

			// Log out from the account menu; the account button then names the guest session.
			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
				timeout: 15_000
			});

			// Anonymous again, same browser: this conversation is the one the returning login must not
			// orphan.
			await installCannedReplies(page);
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Suggest one name for a small bakery in one short sentence.');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationUrl = page.url();

			// Through the rail's "Log in", for the reason the CUR-849 test above gives (CUR-1578).
			await signInWithEmailOtp(page, databaseUrl, email, {
				viaNavLink: true,
				landsOn: new RegExp(`${new URL(conversationUrl).pathname}$`)
			});

			// The CUR-849 test's own regression shape: a failed migration doesn't error, it silently
			// redirects to a blank new chat instead of this URL, which is why the URL itself gets read
			// back here rather than trusting the message text alone.
			await expect(page).toHaveURL(conversationUrl);
			await expect(
				page.getByText('Suggest one name for a small bakery in one short sentence.'),
				'the conversation from before the returning sign-in should still be here — a returning ' +
					'login is expected to migrate a fresh anonymous session exactly like a first login does'
			).toBeVisible({ timeout: 15_000 });
		}
	);

	// A1 step 14 (CUR-2791, case a). The CUR-1719 test above signs back into an account with nothing in
	// it. A real returning person already has chats, and signing in from a guest session has to add the
	// guest's chat to them without losing either. While they are signed out, the account's chat must
	// not show in the guest's rail either, since whoever uses the device next is that guest.
	test(
		"a returning person keeps their account's chats and the one they had as a guest, and the guest never sees the account's",
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(240_000);
			const email = freshTestEmail();
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			const composer = page.getByLabel('Message AI Potluck');
			await installCannedReplies(page);

			/** Sends one question from a new chat and returns its path once the answer has finished. */
			async function chat(question: string): Promise<string> {
				await page.goto(chatEntry(), { waitUntil: 'commit' });
				// A second chat has no "Welcome to Alpha" to wait on, so Enter could reach the server-rendered
				// box before the app has, and send nothing (CUR-3311). Wait for the app to take the box over.
				await composerHydrated(page);
				await composer.click({ timeout: 30_000 });
				await composer.fill(question);
				await composer.press('Enter');
				await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
				await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
					timeout: 90_000
				});
				return new URL(page.url()).pathname;
			}
			const railLink = (path: string) => page.locator(`a[href$="${path}"]`).first();

			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			const accountChat = await chat('Name one mountain in Norway in one short sentence.');

			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
				timeout: 15_000
			});
			const guestChat = await chat('Name one island in Greece in one short sentence.');
			await expect(
				railLink(accountChat),
				"the signed-out guest's rail lists the account's chat"
			).not.toBeAttached();

			// Outside the step: the sign-in marks rows 3 and 5 itself.
			await signInWithEmailOtp(page, DATABASE_URL!, email, {
				viaNavLink: true,
				skipPendingLabelCheck: true,
				landsOn: new RegExp(`${guestChat}$`)
			});
			await journeyStep(page, 'A1', 14, async () => {
				await expect(
					railLink(guestChat),
					'the chat from the guest session did not come onto the account'
				).toBeAttached({ timeout: 15_000 });
				await expect(
					railLink(accountChat),
					"the account's own chat from before signing out is gone after signing back in"
				).toBeAttached({ timeout: 15_000 });
				await holdForRecording(page);
			});
		}
	);

	// CUR-2791, case b. Tabs share one cookie jar, so signing in from one tab signs in every other tab of
	// the same browser. A second tab that kept showing "Guest" after a reload would invite the person to
	// sign in twice, or to keep chatting where nothing is saved to the account.
	test('a second tab open as a guest shows the account once the first tab signs in and it reloads', async ({
		page,
		context
	}) => {
		const email = freshTestEmail();
		const other = await context.newPage();
		await other.goto(chatEntry(), { waitUntil: 'load' });
		await expect(accountButton(other)).toHaveAccessibleName('Account — guest', { timeout: 15_000 });

		await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });

		await other.reload({ waitUntil: 'load' });
		await expect(
			accountButton(other),
			'the second tab still shows a guest after the first tab signed in'
		).not.toHaveAccessibleName('Account — guest', { timeout: 15_000 });
		const session = await other.evaluate(async () => {
			const res = await fetch('/chat/api/auth/get-session');
			return (await res.json()) as { user?: { email?: string } } | null;
		});
		expect(session?.user?.email).toBe(email);
		await other.close();
	});

	// CUR-2791, case c. The sign-in page turns a signed-in person away (login/+page.server.ts), so the
	// only way to sign in as B while A is signed in is two tabs: the first is halfway through B's code
	// when the second signs in as A and chats. B's sign-in then carries A's session cookie into the
	// guest-chat migration (auth.ts), which must move nothing of A's. A's chats carry a userId and no
	// sessionId (conversation/+server.ts), so this is a guard on that shape.
	test("signing in as B in one tab while A signed in from another leaves A's chats out of B's account", async ({
		page,
		context
	}) => {
		test.setTimeout(180_000);
		const emailA = freshTestEmail();
		const emailB = freshTestEmail();
		await installOtpBypassHeader(page);
		await page.goto('/chat/login', { waitUntil: 'load' });
		await page.locator('#signin-email').fill(emailB);
		await page.getByRole('button', { name: 'Continue with email' }).click();
		await page.getByText(`We sent a 6-digit code to ${emailB}.`).waitFor({ state: 'visible' });

		const other = await context.newPage();
		const welcomeDialog = other.getByRole('dialog', { name: 'Welcome to Alpha' });
		await other.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installCannedReplies(other);
		await signInWithEmailOtp(other, DATABASE_URL!, emailA, { skipPendingLabelCheck: true });
		const composer = other.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name one river in Chile in one short sentence.');
		await composer.press('Enter');
		await other.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const chatOfA = new URL(other.url()).pathname;
		await expect(turnDone(other.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 90_000
		});
		await other.close();

		await page.locator('#signin-otp').fill(await readSignInOtp(DATABASE_URL!, emailB));
		await page.waitForURL(/\/chat\/?(\?|$)/, { timeout: 15_000 });
		const session = await page.evaluate(async () => {
			const res = await fetch('/chat/api/auth/get-session');
			return (await res.json()) as { user?: { email?: string } } | null;
		});
		expect(session?.user?.email).toBe(emailB);
		await expect(
			page.getByText('Name one river in Chile in one short sentence.'),
			"B's account shows A's chat"
		).toHaveCount(0);
		await expect(page.locator(`a[href$="${chatOfA}"]`), "B's rail lists A's chat").toHaveCount(0);
		const opened = await page.goto(chatOfA, { waitUntil: 'load' });
		await expect(
			page.getByText('Name one river in Chile in one short sentence.'),
			`B can open A's chat at its address (status ${opened?.status()})`
		).toHaveCount(0);
	});

	// The new tests below pass skipPendingLabelCheck: the "Signing you in…" label is step 6's claim, checked by
	// the test above, and a fast redirect can beat its 5s window (CUR-1696).
	//
	// A1 step 10 (CUR-2627). Signing out has to leave the shared device the way a stranger would find
	// it: the rail offers "Log in" again, and the address of a chat they had while signed in no longer
	// shows that chat. A sign-out that only swapped the label would pass the first half and fail the
	// second.
	test(
		'signing out puts Log in back in the rail, and the chat they had signed in is gone from its address',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(180_000);
			const question = 'Name one river that flows through Vienna in one short sentence.';
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await installCannedReplies(page);
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), {
				skipPendingLabelCheck: true
			});

			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationUrl = page.url();
			await expect(page.getByText(question).first()).toBeVisible({ timeout: 15_000 });

			await journeyStep(page, 'A1', 10, async () => {
				// This label check has gone red with the account still named (CUR-3931). A slow sign-out
				// request and a refused one look the same from the label, and only the second leaves a live
				// session, so a red records the request's status and time and whether the server still
				// holds a session before failing.
				const clickedAt = Date.now();
				const signOut = page
					.waitForResponse((r) => r.url().includes('/api/auth/sign-out'), { timeout: 30_000 })
					.then(
						(r) => ({ status: r.status(), ms: Date.now() - clickedAt }),
						() => null
					);
				await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
				const signedOutLabel = await expect(accountButton(page))
					.toHaveAccessibleName('Account — guest', { timeout: 15_000 })
					.then(
						() => true,
						() => false
					);
				// The verdict is the 15 s read above. A second read here would land inside the hard reload
				// Log out starts and read the button mid-render, unnamed, after a sign-out that worked.
				if (!signedOutLabel) {
					const label = await accountButton(page)
						.getAttribute('aria-label', { timeout: 1_000 })
						.catch(() => null);
					const session = await page.request
						.get('/chat/api/auth/get-session')
						.then(async (r) => ({
							status: r.status(),
							live: (await r.json().catch(() => null)) !== null
						}))
						.catch((e: unknown) => ({ error: String(e) }));
					const evidence = JSON.stringify({ label, signOut: await signOut, sessionAfter: session });
					console.log(`CUR-3931 sign-out evidence: ${evidence}`);
					test.info().annotations.push({ type: 'CUR-3931 sign-out', description: evidence });
				}
				expect(
					signedOutLabel,
					'after Log out the account button still names a signed-in account'
				).toBe(true);
				await accountMenuItem(page, 'Log in', { timeout: 20_000 });
				await page.keyboard.press('Escape');
				await holdForRecording(page);

				await page.goto(conversationUrl, { waitUntil: 'load' });
				await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
					timeout: 15_000
				});
				await expect(
					page.getByText(question),
					'the signed-in chat still shows at its address after signing out'
				).toHaveCount(0, { timeout: 15_000 });
			});
		}
	);

	// Log out used to ignore a refused sign-out request and reload anyway, which put the person
	// straight back into the session they had just asked to end, with nothing on screen to say so (CUR-3931). A
	// refused request now has to say so and leave them where they are, and the next Log out works.
	test(
		'a refused sign-out says the person is still signed in instead of reloading into the live session',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(150_000);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), {
				skipPendingLabelCheck: true
			});
			await expect(accountButton(page)).toHaveAccessibleName(/Account — signed in as/, {
				timeout: 20_000
			});

			await page.route(
				'**/chat/api/auth/sign-out',
				(route) =>
					route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: JSON.stringify({ message: 'refused by the CUR-3931 scenario' })
					}),
				{ times: 1 }
			);
			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await expect(
				page.getByTestId('chat-error-toast'),
				'a refused sign-out tells the person'
			).toContainText("Log out didn't go through, so you're still signed in", { timeout: 15_000 });
			await expect(
				accountButton(page),
				'the account button still names the account the refused sign-out left signed in'
			).toHaveAccessibleName(/Account — signed in as/);

			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await expect(
				accountButton(page),
				'the second Log out signs the person out'
			).toHaveAccessibleName('Account — guest', { timeout: 15_000 });
		}
	);

	// A1 step 11 (CUR-2627). Active sessions on the account page has to describe the account's real
	// sessions and end the one it says it ends. Two browser contexts are two devices: the second
	// signs in, the first sees both and ends the other, and the second finds itself signed out the
	// next time it asks the server anything.
	test(
		'a second device shows up under Active sessions, and ending it signs that device out',
		{ tag: '@A1' },
		async ({ page, browser, baseURL }) => {
			test.setTimeout(240_000);
			const email = freshTestEmail();
			await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
			// The recording films this device while the second one signs in off camera. Left on the chat,
			// it sits on the newcomer tour for those seconds, and row 11's clip opened on it. Waiting on the
			// account page instead keeps the tour out of the film; the step's own goto lands on the same URL.
			await page.goto('/chat/settings/account', { waitUntil: 'load' });

			const other = await browser.newContext({ baseURL });
			try {
				const otherPage = await other.newPage();
				await signInWithEmailOtp(otherPage, DATABASE_URL!, email, { skipPendingLabelCheck: true });

				// Two visits to row 11: the list with both devices, then what ending one leaves behind.
				const { sessions, endOther } = await journeyStep(page, 'A1', 11, async () => {
					await page.goto('/chat/settings/account', { waitUntil: 'load' });
					const sessions = page
						.locator('section')
						.filter({ has: page.getByRole('heading', { name: 'Active sessions' }) });
					await expect(
						sessions.getByText('This device', { exact: true }),
						'Active sessions does not mark the device the person is on'
					).toBeVisible({ timeout: 30_000 });
					const endOther = sessions.getByRole('button', { name: 'End session' });
					await expect(
						endOther,
						'Active sessions lists one other device to end, not the second sign-in'
					).toHaveCount(1, { timeout: 15_000 });
					// Each device reads as a browser and system, not a raw user-agent string, so a
					// person can tell their own two sessions apart (CUR-2735).
					const devices = sessions.getByTestId('session-device');
					await expect(devices, 'Active sessions does not list both devices').toHaveCount(2);
					for (const label of await devices.allInnerTexts()) {
						expect(label, 'a session is labelled with its raw user agent').not.toMatch(
							/^Mozilla\//
						);
						expect(label, 'a session is not labelled as a browser on a system').toMatch(/ on /);
					}
					// The list sits below Linked providers and Passkeys; the recording only shows step 11 if
					// the two-session state is on screen while it holds.
					await sessions.scrollIntoViewIfNeeded();
					await holdForRecording(page);
					return { sessions, endOther };
				});

				await journeyStep(page, 'A1', 11, async () => {
					// While the request runs the button reads "Ending…", so counting "End session" alone reaches
					// zero whether or not anything ended. Both labels gone means the row itself is gone.
					const otherRow = sessions.getByRole('button', { name: /^(End session|Ending…)$/ });
					await endOther.click();
					await expect(otherRow, 'the ended session is still listed after End session').toHaveCount(
						0,
						{ timeout: 15_000 }
					);
					await page.reload({ waitUntil: 'load' });
					await expect(sessions.getByText('This device', { exact: true })).toBeVisible({
						timeout: 30_000
					});
					await expect(
						sessions.getByRole('button', { name: 'End session' }),
						'the ended session is listed again after a reload'
					).toHaveCount(0);
					// The reload returns to the top of the page, so the shortened list was never on
					// screen while the recording held (CUR-2750).
					await sessions.scrollIntoViewIfNeeded();
					await captionForRecording(
						page,
						'reloaded after ending the other session; only this device is listed'
					);

					await otherPage.goto(chatEntry(), { waitUntil: 'load' });
					await expect(
						accountButton(otherPage),
						'the device whose session was ended is still signed in on its next request'
					).toHaveAccessibleName('Account — guest', { timeout: 15_000 });
					// The second device is its own browser context, which the recording does not film, so its
					// result is shown here, on the first device's screen.
					await captionForRecording(
						page,
						'the other device opened the chat again and is signed out: its account menu reads "Guest"'
					);
				});
			} finally {
				await other.close();
			}
		}
	);

	// A1's steps 6→7 are supposed to feel like nothing happened (CUR-1673): the same conversation, in
	// the same place. The nav's "Log in" linked to `${base}/login` with no `next`, so
	// `login/+page.svelte`'s `data.next ?? `${base}/`` dropped anyone signing in mid-conversation at
	// the generic chat entry — the "fresh empty chat home with unrelated prompt suggestions" the
	// journey grader kept filing.
	//
	// This drives the real link rather than a goto, because the link IS the defect; a `page.goto`
	// with a hand-built query would prove the login page honours `next` (which it already did) and
	// nothing about what a person clicking that link gets.
	//
	// 120s: this walks a send, a conversation, and a full OTP round trip on the preview tier, and the
	// suite default is 90s. No single assertion below comes near that, so check:scenario-budgets is
	// satisfied either way — the budget is here because the test is long, not because an assertion is.
	test(
		'signing in from inside a conversation returns to that conversation, not the chat entry',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(120_000);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await installCannedReplies(page);

			// `load`, not `commit`, for the reason the nav-link test below records under CUR-1479: the
			// rail renders twice server-side and a strict-mode role query in the pre-CSS window can catch
			// both copies and throw without retrying.
			await page.goto(chatEntry(), { waitUntil: 'load' });

			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name one mountain in Norway in one short sentence.');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const conversationUrl = page.url();
			const conversationPath = new URL(conversationUrl).pathname;

			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), {
				viaNavLink: true,
				landsOn: new RegExp(`${conversationPath}$`)
			});

			// The URL is the whole claim, so it is asserted directly rather than through the message
			// text: a person can be looking at their conversation because they navigated back to it,
			// and only the landing URL says sign-in put them there.
			expect(
				new URL(page.url()).pathname,
				'signing in from inside a conversation landed somewhere else, which is the chat entry unless the link carried `next`'
			).toBe(conversationPath);
			await expect(
				page.getByText('Name one mountain in Norway in one short sentence.')
			).toBeVisible({ timeout: 15_000 });
		}
	);

	// Every other test here starts at the chat entry, so nothing walked the way a visitor
	// actually arrives (CUR-2698). Develop's home page carried a CMS card linking https://chat.aipotluck.org,
	// which opened production's chat in a new tab. A visitor on develop then signed in on production
	// and never reached this deployment's sign-in at all. The links come from CMS content that differs
	// per environment, so the contract is stated over all of them: every chat link on the home page
	// stays on this origin, and following one by clicking reaches this deployment's sign-in. A home
	// page with no chat link of its own is walked through the Alpha page it links (CUR-4543).
	test(
		'every chat link on the home page stays on this deployment, and clicking one reaches its sign-in',
		{ tag: '@A1' },
		async ({ page, baseURL }) => {
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			const origin = new URL(baseURL!).origin;

			const chatLinksHere = () =>
				page.locator('a[href]').evaluateAll((anchors) =>
					anchors
						.map((a) => ({ href: (a as HTMLAnchorElement).href, target: a.getAttribute('target') }))
						.filter(({ href }) => {
							const url = new URL(href);
							return (
								url.pathname.startsWith('/chat') ||
								/^(chat|alpha)\.aipotluck\.org$/.test(url.hostname)
							);
						})
				);
			// Scroll through the window as a visitor would, then click. Playwright's automatic scroll instead
			// moves ScrollSmoother's fixed wrapper, which hands that offset back to the window during the
			// click and can move the target out from under the pointer.
			// The wheel's eased scroll was still moving when the
			// click came, and every retry found the fixed nav bar over the link. So the pointer goes
			// down only where the link holds still across two frames with nothing on top of it.
			const clickWhereStill = async (link: Locator) => {
				let target = { x: 0, y: 0 };
				await expect(async () => {
					const at = await link.evaluate(async (el) => {
						const centre = () => {
							const rect = el.getBoundingClientRect();
							return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
						};
						const before = centre();
						await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
						const after = centre();
						const top = document.elementFromPoint(after.x, after.y);
						return {
							...after,
							offset: after.y - window.innerHeight / 2,
							still: before.x === after.x && before.y === after.y,
							uncovered: top !== null && el.contains(top)
						};
					});
					if (at.still && !at.uncovered) await page.mouse.wheel(0, at.offset);
					expect(at.still, 'the link was still moving under the pointer').toBe(true);
					expect(at.uncovered, 'something on the page covers the link').toBe(true);
					target = at;
				}).toPass({ timeout: 15_000 });
				await page.mouse.click(target.x, target.y);
			};

			await journeyStep(page, 'A1', 1, async () => {
				await page.goto('/', { waitUntil: 'load' });
				// The lazy scroll enhancement can still start after `load`. Let it finish before
				// moving down the page; starting it in the middle of a mouse gesture moves the target.
				await page.waitForFunction(
					() =>
						!matchMedia(
							'(min-width: 48rem) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'
						).matches || document.documentElement.classList.contains('scroll-smoothed'),
					undefined,
					{ timeout: 15_000 }
				);
				let chatLinks = await chatLinksHere();
				// A home page can lead into chat through its Alpha page instead of linking chat
				// itself (develop's CMS home does (CUR-4543): its "Try Alpha" card opens /alpha, which links /chat). A
				// visitor takes that page on the way, so the walk does too, by clicking. The Alpha page
				// scrolls natively, so there is no smoothing to wait for once it loads.
				if (chatLinks.length === 0) {
					const alphaPath = await page.locator('a[href^="/"]').evaluateAll(
						(anchors) =>
							anchors
								.filter((a) => /\balpha\b/i.test(a.textContent ?? ''))
								.map((a) => a.getAttribute('href')!)
								.find((href) => !href.startsWith('/chat')) ?? null
					);
					expect(
						alphaPath,
						'the home page should offer a way into chat, directly or through a link naming Alpha'
					).not.toBeNull();
					await clickWhereStill(page.locator(`a[href="${alphaPath}"]:visible`).first());
					await expect(page).toHaveURL(`${origin}${alphaPath}`, { timeout: 15_000 });
					await page.waitForLoadState('load');
					chatLinks = await chatLinksHere();
				}
				expect(
					chatLinks.length,
					'the home page, or the Alpha page it links, should offer at least one way into chat'
				).toBeGreaterThan(0);
				for (const link of chatLinks) {
					expect(
						new URL(link.href).origin,
						`chat link ${link.href} should stay on ${origin}, not send the visitor to another deployment`
					).toBe(origin);
					expect(link.target, `chat link ${link.href} should not open a new tab`).not.toBe(
						'_blank'
					);
				}

				await clickWhereStill(page.locator('a[href^="/chat"]:visible').first());
				try {
					await expect(page).toHaveURL(new RegExp(`^${origin.replace(/\./g, '\\.')}/chat`), {
						timeout: 15_000
					});
				} catch (err) {
					// The router can fetch /chat's data and every one of its files with 200s inside 400 ms of the click,
					// log nothing, and leave the URL on /. The trace shows the network side only. A resource-timing entry
					// exists only for a response the page itself received, so this tells a stalled delivery apart from a
					// router that got everything and still never navigated.
					const seen = await page.evaluate(() => {
						const entries = performance.getEntriesByType('resource').map((e) => e.name);
						return {
							chatData: entries.some((n) => n.includes('/chat/__data.json')),
							routeNodes: entries.filter((n) => /\/_app\/immutable\/nodes\//.test(n)).length,
							scripts: entries.filter((n) => /\/_app\/immutable\/.*\.js$/.test(n)).length
						};
					});
					test.info().annotations.push({
						type: 'chat link did not navigate',
						description: JSON.stringify(seen)
					});
					throw err;
				}
				await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
				await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
					timeout: 15_000
				});
			});

			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), { viaNavLink: true });
			await expect(page).toHaveURL(new RegExp(`^${origin.replace(/\./g, '\\.')}/chat`));
			await expect(accountButton(page)).toHaveAccessibleName(/signed in as /i, { timeout: 15_000 });
		}
	);

	// CUR-432 ("Show me that I am signed in"): the Done-when bar was "the account
	// name somewhere visible, and a difference between the signed in and signed out state that you
	// notice without looking for it." The tests above reach sign-in via page.goto('/chat/login') —
	// a shortcut that never proves a real visitor notices "Log in" or sees it replaced afterward.
	// This one clicks the actual nav link and asserts the confirmation CUR-432 shipped in its place.
	test(
		'clicking "Log in" in the nav, not a direct URL, ends with a visible "Signed in as" confirmation',
		{ tag: '@A1' },
		async ({ page }) => {
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});

			// CUR-1479: `commit` fires as soon as the response starts arriving, before the page's own
			// stylesheet has applied — ChatShell.svelte server-renders NavMenu twice (once inside
			// MobileNav's drawer, once in the desktop rail) and relies on `md:hidden`/`max-md:hidden`
			// to show only one per viewport. A strict-mode role query run in that pre-CSS window can
			// catch both anchors still visible and throw immediately (Playwright doesn't retry a
			// strict-mode violation the way it retries "not found yet"). `commit` fails intermittently against a
			// real preview; `load` (stylesheets applied) does not. The
			// settled DOM only ever has one visible link — a startup race that resolves on its own, so
			// the fix is waiting past it rather than loosening the locator with `.first()`.
			// CHAT_ENTRY, never a pinned entry: sign-in returns to the page it started from, and the
			// landing this test asserts is `/chat`.
			await page.goto(CHAT_ENTRY, { waitUntil: 'load' });
			await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
				timeout: 15_000
			});

			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail(), { viaNavLink: true });

			// The account button's accessible name is "Account — signed in as {name}" once sign-in took,
			// and its menu offers Log out instead of Log in (CUR-432).
			await journeyStep(page, 'A1', 7, async () => {
				await expect(accountButton(page)).toHaveAccessibleName(/signed in as /i, {
					timeout: 15_000
				});
				await accountMenuItem(page, 'Log out', { timeout: 20_000 });
				await expect(page.getByRole('menuitem', { name: 'Log in' })).toBeHidden();

				// The menu names the person the way they wrote it, not in the UI's label case (CUR-2217). The
				// DOM text is the same either way, so the rendered case is read from the computed style.
				const signedInAs = (await accountButton(page).getAttribute('aria-label'))!.replace(
					'Account — signed in as ',
					''
				);
				await expect(
					page.getByRole('menu').getByText(signedInAs, { exact: true }),
					'the account menu should show who is signed in in their own case, not in capitals'
				).toHaveCSS('text-transform', 'none');
				await holdForRecording(page);
			});
		}
	);

	// A1 step 9 (CUR-1758): `a1-sign-in.md`'s coverage block marked
	// this `kind: none` — nothing anywhere drove or displayed the state a second sign-in on the same
	// email actually reaches. Driving a REAL collision needs two live OAuth accounts on one address
	// — the same CI blocker step 4 already names (CUR-1551/CUR-1552/CUR-1696) — but the warning
	// itself is deterministic, client-side, and query-param-driven: betterAuth.ts's
	// disableImplicitLinking makes Better Auth round-trip a real failed callback back to
	// `errorCallbackURL` (this same login page) with `?error=account_not_linked`, and
	// +page.svelte's onMount reads that param with no server dependency at all
	// (`friendlyAuthErrorMessage`, authErrorMessages.ts). Landing on that URL directly exercises the
	// exact client code a real collision would run.
	//
	// Guards a client-side crash on any `?error=` param (`reading '$set'`, CUR-1813): onMount defers its
	// replaceState a tick.
	test(
		'a second sign-in on an already-used email is told plainly, before anything else, that this makes a second account',
		{ tag: '@A1' },
		async ({ page }) => {
			await journeyStep(page, 'A1', 9, async () => {
				await page.goto('/chat/login?error=account_not_linked', { waitUntil: 'commit' });

				// The exact copy authErrorMessages.ts ships for this code, held with a real `expect` —
				// per the frame-sampling note in docs/journeys/README.md, so a graded recording actually
				// sees this screen rather than passing through it.
				await expect(
					page.getByText(
						phrase(
							'An account with this email already exists. Sign in the way you originally did, then add this as another way in from Settings → Account.'
						)
					)
				).toBeVisible({ timeout: 15_000 });
			});
		}
	);

	// Second half of the same step: the warning above promises a specific place to finish the link
	// ("Settings → Account"), and that promise is only honest if the control it points to actually
	// exists. Signs in fresh via email-OTP (the one route this suite can drive end to end) and checks
	// that the account this creates offers a real, enabled way to add another provider — Hugging Face
	// is `LINKABLE_PROVIDERS`' one entry `authProviderMeta.ts` marks always-configured, so this holds
	// regardless of which OAuth client ids happen to be set in this environment.
	//
	// Deliberately does not click "Link": that button hands the browser to a real
	// window.location.href redirect to Hugging Face's own OAuth authorize endpoint, which this suite
	// has no account to complete and no business sending real traffic to in CI. Reaching that
	// provider and actually finishing the link is the same OAuth-infrastructure gap as step 4 — filed
	// as CUR-1811, not solved here.
	test(
		'the account page offers a real, working way to add another sign-in provider',
		{ tag: '@A1' },
		async ({ page }) => {
			await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail());

			await page.goto('/chat/settings/account', { waitUntil: 'commit' });

			// `.filter({has})` matches ANY ancestor containing both, so a bare 'div' resolves to every
			// wrapping container up the tree as well as the row itself (strict-mode violation, 8
			// matches). `:scope > button` restricts "has" to a DIRECT child, which only
			// the row div itself satisfies — none of its ancestors have the Link button as an immediate
			// child.
			const hfRow = page
				.locator('div')
				.filter({ has: page.getByText('Hugging Face', { exact: true }) })
				.filter({ has: page.locator(':scope > button', { hasText: 'Link' }) });
			await expect(
				hfRow,
				'a fresh email-OTP account has no Hugging Face account linked, so this row should offer to add one — an account_not_linked visitor is pointed here by name and finding nothing here would make that warning a dead end'
			).toBeVisible({ timeout: 15_000 });
			await expect(hfRow.getByRole('button', { name: 'Link' })).toBeEnabled();
		}
	);

	// An account that signs in by email code alone saw "Nothing linked yet." under Linked
	// providers, so the page named no way it signs in (CUR-3049). Email code works for every account with an
	// address, and nothing can remove it, so it is listed with that reason and no button.
	test(
		'an account that signs in by email code sees email code listed as a sign-in method that cannot be removed',
		{ tag: '@A1' },
		async ({ page }) => {
			const email = freshTestEmail();
			await signInWithEmailOtp(page, DATABASE_URL!, email);

			await page.goto('/chat/settings/account', { waitUntil: 'commit' });

			const row = page.getByTestId('sign-in-method-email');
			await expect(row, 'the account page lists no email-code sign-in method').toBeVisible({
				timeout: 30_000
			});
			await expect(row).toContainText('Email code');
			await expect(
				row,
				'the email-code row does not name the address the code goes to'
			).toContainText(email);
			await expect(row).toContainText(
				'You can always sign in with a code sent to this address, so it can’t be removed.'
			);
			await expect(
				row.getByRole('button'),
				'email code offers a control that cannot do anything'
			).toHaveCount(0);
		}
	);

	// After a wrong code, "Use a different email" went back to the email step but left the
	// wrong code bound to the code field, so the next address's code screen opened already filled with
	// it (CUR-1887). Drives the real wrong-code path: a guessed code auto-submits at six digits and the server
	// rejects it.
	test(
		'switching email after a wrong code opens the next code screen empty',
		{ tag: '@A1' },
		async ({ page }) => {
			await installOtpBypassHeader(page);
			await page.goto('/chat/login');

			const code = page.locator('#signin-otp');
			const sendTo = async (email: string) => {
				await page.locator('#signin-email').fill(email);
				await page.getByRole('button', { name: 'Continue with email' }).click();
				await expect(page.getByText(`We sent a 6-digit code to ${email}.`)).toBeVisible({
					timeout: 30_000
				});
			};

			await sendTo(freshTestEmail());
			await code.fill('000000');
			await expect(
				page.getByText("That code doesn't match. Check it and try again."),
				'the guessed code should be rejected, or this test is not on the wrong-code path'
			).toBeVisible({ timeout: 15_000 });

			await page.getByRole('button', { name: 'Use a different email' }).click();
			await sendTo(freshTestEmail());
			await expect(
				code,
				'the code screen for the new address should open empty, not holding the rejected code'
			).toHaveValue('');
		}
	);

	// The code field had to be clicked before a person could type the code (CUR-2298). Checked on the
	// first code screen and again after "Use a different email", because each opens a new field.
	test(
		'the code field has focus when the code screen opens, including after switching email',
		{ tag: '@A1' },
		async ({ page }) => {
			await installOtpBypassHeader(page);
			await page.goto('/chat/login');

			const code = page.locator('#signin-otp');
			for (const attempt of ['first', 'after switching email']) {
				if (attempt !== 'first') {
					await page.getByRole('button', { name: 'Use a different email' }).click();
				}
				const email = freshTestEmail();
				await page.locator('#signin-email').fill(email);
				await page.getByRole('button', { name: 'Continue with email' }).click();
				await expect(page.getByText(`We sent a 6-digit code to ${email}.`)).toBeVisible({
					timeout: 30_000
				});
				await expect(
					code,
					`the code field is not focused on the ${attempt} code screen`
				).toBeFocused();
			}
		}
	);

	// From 768px up the expanded sidebar is an overlay 294px wide, and before the fix it stayed
	// open across navigation, so "Log in" clicked from it landed on a sign-in page with the panel still
	// floating over the email field (CUR-1899). 900px is narrow enough that the centred form sits under the panel.
	test.describe('at a narrow desktop width', () => {
		test.use({ viewport: { width: 900, height: 720 } });

		test(
			'Log in clicked from the open sidebar lands on a sign-in page whose email field the sidebar does not cover',
			{ tag: ['@A1', '@preview-only'] },
			async ({ page }) => {
				// The welcome covers the whole app, rail included, so the account menu waits for it to close.
				const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
				await page.addLocatorHandler(welcomeDialog, async () => {
					await startChattingPastWelcome(welcomeDialog);
				});
				await page.goto(chatEntry());

				// The sidebar is open by default at this width; open it if a stored preference collapsed it.
				const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
				if (await openSidebar.isVisible()) await openSidebar.click();
				await expect(
					page.getByRole('button', { name: 'Collapse sidebar' }),
					'the sidebar should be open before Log in is clicked, or this test is not on the covered path'
				).toBeVisible();

				// A full page load remounts the rail collapsed and would pass this test with or without the
				// fix, which is how it passed against a pre-fix build entered from /alpha/chat. The marker
				// survives only an in-app navigation, the one path where the rail's own state carries over.
				await page.evaluate(() => ((window as unknown as { cur1899?: boolean }).cur1899 = true));
				await (await accountMenuItem(page, 'Log in', { timeout: 20_000 })).click();
				await page.waitForURL(/\/chat\/login/);
				expect(
					await page.evaluate(() => (window as unknown as { cur1899?: boolean }).cur1899),
					'Log in should navigate within the app; a full page load resets the sidebar and tests nothing'
				).toBe(true);

				// The redesigned sidebar sits beside the page rather than over it, so the claim is that the
				// email field starts to the right of it.
				const sidebarRight = await page
					.getByRole('button', { name: 'Collapse sidebar' })
					.first()
					.evaluate((el) => (el.closest('aside, nav') ?? el).getBoundingClientRect().right);
				const fieldLeft = (await page.locator('#signin-email').boundingBox())!.x;
				expect(
					fieldLeft,
					`the email field starts at ${fieldLeft}px, under the sidebar that ends at ${sidebarRight}px`
				).toBeGreaterThanOrEqual(sidebarRight);
				// A click fails its actionability check when another element would receive it, so this is
				// the "can a person actually reach the field" assertion, not just a visibility one. It aims
				// at the field's left edge: at 900px the open sidebar covers only the first ~16px, so a
				// default centre click reached the field even on the pre-fix build.
				const email = page.locator('#signin-email');
				await email.click({ position: { x: 8, y: 8 }, timeout: 10_000 });
				await expect(email, 'the click should have landed in the email field').toBeFocused();
			}
		);
	});
});

// The account page named every linked provider but never which account a person was looking at, and
// the sidebar rendered the signed-in name in capitals, so an email read "E2E-…@EXAMPLE.ORG" — not
// the address the person typed. innerText applies CSS text-transform, so it reads what is on screen.
test(
	'the account page shows the signed-in email, and the sidebar shows it as typed rather than in capitals',
	{ tag: ['@preview-only', '@A1'] },
	async ({ page }) => {
		const email = freshTestEmail();
		await signInWithEmailOtp(page, DATABASE_URL!, email);

		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		// Scoped to the page's own line: the sidebar carries the same words when the name is the email.
		await expect(
			page.getByTestId('account-email'),
			'the account page does not say which email this account signs in with'
		).toHaveText(`Signed in as ${email}`, { timeout: 30_000 });

		// The sidebar's account button shows the name. The welcome dialog can mount over it at any point.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
		const railLabel = accountButton(page);
		await expect(railLabel).toHaveAccessibleName(/signed in as /i, { timeout: 15_000 });
		// The button reads the avatar's initial, the name, then "Signed in"; the name is the address.
		const lines = (await railLabel.innerText())
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		const name = lines.find((l) => l.includes('@')) ?? lines[1] ?? '';
		expect(name, 'the sidebar shows no name for the signed-in account').not.toBe('');
		expect(
			name,
			`the sidebar shows the signed-in name as "${name}" — it has been uppercased, so an email no longer reads as the address typed`
		).not.toBe(name.toUpperCase());
	}
);

// On the login page itself, the rail's "Log in" link used to carry `next=/chat/login`, so finishing
// sign-in from it sent a person back to the login page. There it must keep the page's own `next`,
// or carry none.
test(
	'on the login page, the rail\'s "Log in" link does not send sign-in back to the login page',
	{ tag: ['@preview-only', '@A1'] },
	async ({ page }) => {
		await page.goto('/chat/login', { waitUntil: 'load' });
		const railLogin = await accountMenuItem(page, 'Log in', { timeout: 30_000 });
		const bare = (await railLogin.getAttribute('href')) ?? '';
		expect(
			decodeURIComponent(bare),
			`on /chat/login the rail's Log in link is "${bare}", which returns sign-in to the login page`
		).not.toMatch(/next=[^&]*\/login/);

		await page.goto('/chat/login?next=%2Fchat%2Fsettings%2Faccount', { waitUntil: 'load' });
		await accountMenuItem(page, 'Log in', { timeout: 30_000 });
		await expect(railLogin).toBeVisible({ timeout: 30_000 });
		await expect(
			railLogin,
			"the rail's Log in link dropped the destination the login page was opened with"
		).toHaveAttribute('href', /next=%2Fchat%2Fsettings%2Faccount$/);
	}
);

// An error box appearing on the sign-in card must not move the card under the person
// reading it (CUR-3491). The card used to be centred in the page, so every error that grew it lifted its top
// edge by half the error's height.
test(
	"CUR-3491: an error appearing on the sign-in card leaves the card's top edge where it was",
	{ tag: '@A1' },
	async ({ page }) => {
		await page.goto('/chat/login', { waitUntil: 'load' });
		const card = page.getByRole('dialog', { name: 'Sign in to Alpha' });
		await expect(card).toBeVisible({ timeout: 30_000 });
		const before = (await card.boundingBox())?.y;

		await page.locator('#signin-email').fill('not-an-email');
		await page.getByRole('button', { name: 'Continue with email' }).click();
		await expect(card.getByRole('alert')).toContainText(
			"That doesn't look like a valid email address.",
			{ timeout: 10_000 }
		);
		const after = (await card.boundingBox())?.y;

		expect(before, 'the sign-in card had no box before the error').toBeDefined();
		expect(
			Math.abs((after ?? 0) - (before ?? 0)),
			`the card's top edge moved from y=${before} to y=${after} when the error appeared`
		).toBeLessThanOrEqual(1);
	}
);

// A sign-in code that no longer works (CUR-2793). Both ways a code dies (it expires after 600 s, or
// three wrong tries lock it, and then even the right code is refused) end on copy that tells the
// person to send a new one, and the code screen's "Send a new code" sends it to the same address. The
// email step is driven by hand: signInWithEmailOtp marks A1 steps 5 and 6 itself.
test.describe('a sign-in code that no longer works', () => {
	async function openCodeScreen(page: import('@playwright/test').Page, email: string) {
		await installOtpBypassHeader(page);
		await page.goto('/chat/login');
		// Clicks before hydration do nothing, so retry until the code screen shows.
		await expect(async () => {
			await page.locator('#signin-email').fill(email);
			await page.getByRole('button', { name: 'Continue with email' }).click({ timeout: 5_000 });
			await expect(page.getByText(`We sent a 6-digit code to ${email}.`)).toBeVisible({
				timeout: 10_000
			});
		}).toPass({ timeout: 60_000 });
	}

	/** Types a code (the page submits at six digits) and returns the verify response's status. */
	async function enterCode(page: import('@playwright/test').Page, code: string) {
		const verified = page.waitForResponse(
			(r) => r.url().endsWith('/api/auth/sign-in/email-otp') && r.request().method() === 'POST',
			{ timeout: 30_000 }
		);
		await page.locator('#signin-otp').fill(code);
		return (await verified).status();
	}

	/** A dead code leaves nothing to press but Send a new code: the field is empty and Verify is off. */
	async function expectDeadCodeCleared(page: import('@playwright/test').Page) {
		await expect(
			page.locator('#signin-otp'),
			'the dead code stayed in the field, inviting another Verify that can only fail'
		).toHaveValue('');
		await expect(
			page.getByRole('button', { name: 'Verify and sign in' }),
			'Verify still looks pressable with a code the server already refused for good'
		).toBeDisabled();
	}

	/** Sends a new code from the code screen and signs in with it, landing signed in on the chat. */
	async function resendAndSignIn(
		page: import('@playwright/test').Page,
		databaseUrl: string,
		email: string,
		dead: string
	) {
		await page.getByRole('button', { name: 'Send a new code' }).click();
		await expect(
			page.getByText(`We sent a new code to ${email}.`),
			'Send a new code did not say it sent one to the same address'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('#signin-otp'), 'the dead code stayed in the field').toHaveValue('');
		const fresh = await readSignInOtp(databaseUrl, email);
		expect(fresh, 'the resend reused the dead code').not.toBe(dead);
		await page.locator('#signin-otp').fill(fresh);
		await page.waitForURL(/\/chat\/?(\?|$)/, { timeout: 30_000 });
		const session = await page.evaluate(async () =>
			(await fetch('/chat/api/auth/get-session')).json()
		);
		expect(session?.user?.email, 'the new code did not sign the person in').toBe(email);
	}

	test(
		'an expired sign-in code says so, and Send a new code signs the person in without retyping their email',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(150_000);
			const databaseUrl = process.env.SCENARIO_DATABASE_URL;
			if (!databaseUrl) throw new Error('SCENARIO_DATABASE_URL is not set');
			const email = freshTestEmail();
			await openCodeScreen(page, email);
			const code = await readSignInOtp(databaseUrl, email);
			await expireSignInOtp(databaseUrl, email);
			// Someone else's sign-in in the meantime, as on any busy deployment. Better Auth's
			// verification read used to purge every expired code with it, ours included, so the expired
			// code then read as "doesn't match". This makes that race certain.
			const otherVerify = await page.evaluate(async (other) => {
				const res = await fetch('/chat/api/auth/sign-in/email-otp', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: other, otp: '000000' })
				});
				return res.status;
			}, freshTestEmail());
			expect(otherVerify, "another person's verify was not even read").toBeLessThan(500);

			await journeyStep(page, 'A1', 15, async () => {
				expect(await enterCode(page, code), 'an expired code was not refused').toBe(400);
				await expect(page.getByRole('alert')).toHaveText(
					'That code has expired. Send a new code below.'
				);
				await expectDeadCodeCleared(page);
				await holdForRecording(page);
				await resendAndSignIn(page, databaseUrl, email, code);
			});
		}
	);

	test(
		'three wrong codes lock the code, so even the right one is refused, and Send a new code signs the person in',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(150_000);
			const databaseUrl = process.env.SCENARIO_DATABASE_URL;
			if (!databaseUrl) throw new Error('SCENARIO_DATABASE_URL is not set');
			const email = freshTestEmail();
			await openCodeScreen(page, email);
			const code = await readSignInOtp(databaseUrl, email);
			// Three distinct wrong codes: the page only resubmits a value it has not submitted before.
			const wrong = [1, 2, 3].map((n) => String((Number(code) + n) % 1_000_000).padStart(6, '0'));

			await journeyStep(page, 'A1', 16, async () => {
				for (const attempt of wrong) {
					expect(await enterCode(page, attempt), 'a wrong code was not refused').toBe(400);
					await expect(page.getByRole('alert')).toHaveText(
						"That code doesn't match. Check it and try again."
					);
				}
				expect(
					await enterCode(page, code),
					'the right code after three wrong ones was accepted, so nothing limits guessing'
				).toBe(403);
				await expect(page.getByRole('alert')).toHaveText(
					'Too many tries, so that code no longer works. Send a new code below.'
				);
				await expectDeadCodeCleared(page);
				await holdForRecording(page);
				await resendAndSignIn(page, databaseUrl, email, code);
			});
		}
	);

	// The verify path allows 3 calls a minute per IP and a code dies after 3 wrong tries, so
	// the 429 a fourth quick try gets always lands on a dead code (CUR-3048). The limiter counts in each
	// instance's memory, so four real calls can split across instances and never trip it; this answers
	// the verify call with Better Auth's own 429 (rate-limiter/index.mjs) instead.
	test(
		'a code refused as too many requests is cleared, says to wait, and Send a new code still signs the person in',
		{ tag: '@A1' },
		async ({ page }) => {
			test.setTimeout(150_000);
			const databaseUrl = process.env.SCENARIO_DATABASE_URL;
			if (!databaseUrl) throw new Error('SCENARIO_DATABASE_URL is not set');
			const email = freshTestEmail();
			await openCodeScreen(page, email);
			const code = await readSignInOtp(databaseUrl, email);
			const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

			await page.route('**/api/auth/sign-in/email-otp', (route) =>
				route.fulfill({
					status: 429,
					contentType: 'application/json',
					headers: { 'X-Retry-After': '60' },
					body: JSON.stringify({ message: 'Too many requests. Please try again later.' })
				})
			);
			expect(await enterCode(page, wrong), 'the stand-in limiter did not answer').toBe(429);
			await expect(page.getByRole('alert')).toHaveText(
				'Too many tries in a row, so that code no longer works. Wait a minute, then send a new code below.'
			);
			await expectDeadCodeCleared(page);
			await page.unroute('**/api/auth/sign-in/email-otp');
			await resendAndSignIn(page, databaseUrl, email, code);
		}
	);
});
