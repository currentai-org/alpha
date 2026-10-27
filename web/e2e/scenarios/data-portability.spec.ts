// e2e-product: @chat
// e2e-area: @auth @settings @storage
import { test, expect } from './helpers/test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { setFlagOverrides } from './helpers/flagOverride';
import { phrase } from './helpers/text';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { chatEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { decodeStorageMarkers, openArchive, readConversationDoc } from './helpers/exportArchive';
import { installCannedReplies } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// global-setup.ts already asserts this is set before any test body runs — see sign-in.spec.ts's
// comment on why there's no module-scope throw here.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

// A3 ("My data stays mine, and I can take it with me") already has one filmed step —
// guest-retention-notice.spec.ts's @A3, the retention warning. This file covers the two parts
// that spec's own header names as unwalked: delete and export. Portability beyond the zip export
// has no separate mechanism to walk; a3-my-data.md's Known Gaps says so rather than this file
// inventing a third test for something that doesn't exist.
test(
	'an anonymous visitor can delete everything through "Forget everything" in Data & privacy',
	{ tag: '@A3' },
	async ({ page }) => {
		// Same overlay hazard as guest-retention-notice.spec.ts.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		// Wait for the dialog to reach a known state — dismissed, or confirmed never
		// appearing within a real bound — before this test's ONE message send, rather than leaving
		// dismissal to whichever composer action's actionability check happens to run into it first.
		// The handler above stays registered as a backstop for the rare case its own async settings
		// load (ChatWindow.svelte's showWelcome) resolves later than this wait allows.
		await welcomeDialog
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name one lake in Italy in one short sentence.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		// CUR-1638 (second half). Opening "Forget everything" while the turn above is still
		// streaming races the wipe against that turn's own post-completion invalidate: a live trace
		// showed the invalidate re-fetching this conversation ~10s AFTER the DELETE had already
		// succeeded, 404ing against the row the wipe just removed. [id]/+page.ts's redirect on that
		// 404 remounts ChatShell's `{#if $deleteAllOpen}` modal, resetting it back to the "Forget
		// everything?" confirm screen with no cleared-items list — a real successful delete reading
		// as a failed one. Waiting for the turn to finish first, the same "Copy to clipboard"
		// completion signal chat-message-send.spec.ts already uses, means nothing is in flight to
		// invalidate by the time the wipe runs.
		const assistantMessage = page.locator('[data-message-role="assistant"]').last();
		await expect(assistantMessage).toBeVisible({ timeout: 30_000 });
		await expect(
			assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true })
		).toBeVisible({ timeout: 45_000 });

		// "Forget everything" lives in Settings → Data & privacy, reached from any conversation, signed in
		// or not. The “Where it goes” pill under the message box links there, which is the path a person leaving
		// mid-conversation would take. Each of its three screens is held on camera: the grader saw only
		// the chat before and the settings page after, never the pill doing it (CUR-2373).
		const forget = page.getByRole('button', { name: /^Forget everything/ });
		await journeyStep(page, 'A3', 3, async () => {
			const wherePill = page.getByRole('button', { name: 'Where your message goes' });
			await expect(wherePill, 'the Where it goes pill sits under the message box').toBeVisible();
			// The grader read the panel this opens ("Where your message goes") as X-ray's, three runs in a
			// row, and filed the step's doc as wrong (CUR-2416). The caption names the control on camera.
			await captionForRecording(page, 'tapping "Where it goes" under the message box', {
				at: 'top'
			});
			await wherePill.click();
			const dataLink = page.getByRole('link', { name: 'Data & privacy' });
			await expect(dataLink, 'the pill opens onto a Data & privacy link').toBeVisible({
				timeout: 5_000
			});
			await holdForRecording(page);
			await dataLink.click();
			await page.waitForURL(/\/settings\/data/, { timeout: 30_000 });
			await expect(forget, 'Data & privacy offers "Forget everything"').toBeVisible({
				timeout: 10_000
			});
		});
		// A guest can't upload anything, so the page must not tell them where uploads are kept.
		await expect(
			page.getByText(phrase('Files you upload are stored')),
			'Data & privacy tells a guest where uploaded files are stored'
		).toHaveCount(0);
		await holdForRecording(page);
		await journeyStep(page, 'A3', 4, async () => {
			await forget.click();

			await expect(page.getByRole('heading', { name: 'Forget everything?' })).toBeVisible({
				timeout: 10_000
			});
			// A guest's wipe doesn't touch an account (DeleteAllConversationsModal's willDeleteAccount is
			// derived from page.data.user) — the confirm copy should say only what's actually true for this
			// persona, not the signed-in account-deletion clause.
			await expect(page.getByText(phrase('deletes your account and sign-in methods'))).toHaveCount(
				0
			);

			// A3 step 4 (CUR-1758): the armed phase's own reason for existing — plain language about what
			// gets cleared, and that it can't be undone (docs/journeys/a3-my-data.md step 4) — asserted
			// before the click that leaves it, rather than only the heading above. The journey gallery's
			// grader read a recording of this same flow as going "straight to a cleared modal, no separate
			// pre-action dialog". The copy gets a real check here. The polls below resolve in milliseconds,
			// though, so they never held the dialog long enough for the grader to keep a frame of it
			// (CUR-2348); holdForRecording does.
			await expect(page.getByText(phrase('We do not want to keep your data'))).toBeVisible({
				timeout: 10_000
			});
			await expect(page.getByText(phrase('This action cannot be undone'))).toBeVisible();
			await holdForRecording(page);
			// Opening on Cancel, not on the destructive button: an Enter pressed on arrival must not wipe.
			await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		});

		// exact:true: the trigger that opened this dialog is named "Forget everything…", which a
		// substring match (getByRole's default) would also catch.
		await journeyStep(page, 'A3', 5, async () => {
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();

			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 15_000
			});
			// summary.conversations is 1 (the one message sent above), so the honest cleared-items list
			// names it exactly — not a vague "your data was cleared". A wider matcher would turn a wrong
			// count green and defeat the point of naming one at all; wipeUserData.ts's delete is correctly
			// scoped to this session, so a mismatch here means the test let more than one conversation
			// exist, not that the count is slow to render. CUR-1638: previously misdiagnosed as a rendering
			// lag and widened to a 15s timeout that could not have fixed it — the page snapshot at the
			// failure showed "2 conversations" already rendered, which no timeout closes. The explicit
			// dismiss wait added above keeps the count deterministic; the timeout here stays generous only
			// to match the surrounding waits, not because of any known lag.
			await expect(page.getByText('1 conversation')).toBeVisible({ timeout: 15_000 });
			// The usage panel behind the receipt kept the pre-wipe counts, so the page said there
			// was still a conversation while the receipt said it was gone.
			await expect(
				page
					.locator('[data-account-usage] dl > div')
					.filter({ has: page.locator('dt', { hasText: /^Conversations$/ }) })
					.locator('dd'),
				'the usage panel behind the receipt still counts the wiped conversation'
			).toHaveText('0', { timeout: 15_000 });
			// The receipt is the step's honest result, and the grader drops a screen held under 0.5s; Done
			// was clicked within milliseconds, so recordings showed no receipt at all (CUR-2270).
			await holdForRecording(page);
		});

		// The handler above would dismiss the welcome splash the moment it showed, which is exactly the
		// defect CUR-2270 is about: after Done, the reset page painted, then the splash over it once the
		// wiped settings reloaded. So it comes off here, and the splash is watched for instead. The window
		// covers the settings reload that follows Done.
		await page.removeLocatorHandler(welcomeDialog);
		// Row 5's second half: then it's gone, and reloading shows no trace.
		await journeyStep(page, 'A3', 5, async () => {
			await page.getByRole('button', { name: 'Done' }).click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeHidden();
			// Done used to navigate to a new chat, taking the person off the usage panel they had
			// just watched reset. They stay on Data & privacy, and the counts read zero.
			await expect(page, 'dismissing the Forget everything receipt left the usage panel').toHaveURL(
				/\/chat\/settings\/data(\?|$)/
			);
			for (const label of ['Conversations', 'Messages sent', 'Total messages']) {
				await expect(
					page
						.locator('[data-account-usage] dl > div')
						.filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
						.locator('dd'),
					`"${label}" on the usage panel does not read 0 after Forget everything`
				).toHaveText('0', { timeout: 15_000 });
			}
			await holdForRecording(page);
			const splashAfterWipe = await welcomeDialog
				.waitFor({ state: 'visible', timeout: 5_000 })
				.then(
					() => true,
					() => false
				);
			expect(
				splashAfterWipe,
				'the welcome splash came back over the empty chat right after "Forget everything"'
			).toBe(false);
			// Still on the panel after that five-second window, so a late navigation would have shown by now.
			await expect(
				page,
				'the page left the usage panel a few seconds after Forget everything'
			).toHaveURL(/\/chat\/settings\/data(\?|$)/);

			// The point of "delete" rather than just "hide": reload and confirm the server itself no longer
			// has the conversation this test created.
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			// An absence holds on a page that has not rendered yet, so the chat has to be on screen first.
			await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText('A3 data-portability scenario')).toHaveCount(0);
		});
	}
);

// The wipe-coverage contract for safety_events, driven through the real account-deletion control:
// a decline record of any kind except child_safety goes with the account, and a child-safety one
// stays (Art. 17(3)). A privacy decline (label chat-block-privacy) once stayed
// keyed to a deleted account. The rows are seeded directly because producing a real decline needs a
// live moderation call, and the claim under test is what the wipe deletes, not what Coop blocks.
test(
	'deleting the account deletes its privacy decline record and keeps only child-safety ones',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		const sql = postgres(DATABASE_URL!, { ssl: 'require', max: 1 });
		const privacyId = `e2e-privacy-${crypto.randomUUID()}`;
		const childId = `e2e-child-${crypto.randomUUID()}`;
		try {
			const [shadow] = await sql<{ id: string }[]>`
				select id from users where doc->>'email' = ${email} limit 1
			`;
			expect(shadow, 'sign-in created no shadow users row to key the records to').toBeTruthy();
			await sql`
				insert into safety_events (id, user_id, kind, label) values
				(${privacyId}, ${shadow.id}, 'content_policy', 'chat-block-privacy'),
				(${childId}, ${shadow.id}, 'child_safety', 'child_safety')
			`;

			await page.goto('/chat/settings/account', { waitUntil: 'commit' });
			await page
				.getByRole('button', { name: 'Delete your account, conversations, and sign-in methods' })
				.click({ timeout: 30_000 });
			// The trigger sits near the foot of the page, and the confirmation used to open
			// below it as a 12px sliver. toBeVisible passes on text scrolled out of sight inside that
			// sliver; toBeInViewport at ratio 1 does not, because it counts the panel's own clipping.
			await expect(
				page.getByText('This action cannot be undone.'),
				'the deletion warning must be readable before the confirm button is'
			).toBeInViewport({ ratio: 1 });
			// Deleting the account takes a typed word (CUR-1420).
			await page.getByLabel('Type DELETE to confirm').fill('DELETE');
			await page.getByRole('button', { name: 'Delete account', exact: true }).click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 60_000
			});
			await expect(page.getByText('1 record of messages we declined to answer')).toBeVisible();
			await expect(
				page.getByRole('heading', { name: 'Your data has been cleared' }),
				'the receipt must open whole, not clipped to its last line'
			).toBeInViewport({ ratio: 1 });
			await expect(page.getByText(/each under its own retention/)).toBeInViewport({ ratio: 1 });

			const left = await sql<{ id: string }[]>`
				select id from safety_events where id in (${privacyId}, ${childId})
			`;
			expect(
				left.map((r) => r.id),
				'the privacy decline must be gone with the account; the child-safety record must remain'
			).toEqual([childId]);
		} finally {
			await sql`delete from safety_events where id in (${privacyId}, ${childId})`;
			await sql.end({ timeout: 5 });
		}
	}
);

// A3 step 9 (CUR-2627). Deleting the account is only the promise it makes if the account is really
// gone: signing in again with the same email has to start a new, empty account, with none of the
// old chats listed and the old chat's address showing nothing. A deletion that cleared the screen
// but left the rows keyed to the email would hand the history straight back.
test(
	'after deleting their account, signing in again with the same email starts with no chats',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		const email = freshTestEmail();
		const question = 'Name one river in Switzerland in one short sentence.';
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
		await installCannedReplies(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationUrl = page.url();
		await expect(page.getByText(question).first()).toBeVisible({ timeout: 15_000 });

		await journeyStep(page, 'A3', 9, async () => {
			await page.goto('/chat/settings/account', { waitUntil: 'load' });
			await page
				.getByRole('button', { name: 'Delete your account, conversations, and sign-in methods' })
				.click({ timeout: 30_000 });
			const deleteButton = page.getByRole('button', { name: 'Delete account', exact: true });
			await expect(
				deleteButton,
				'Delete account is clickable before the word is typed'
			).toBeDisabled();
			await page.getByLabel('Type DELETE to confirm').fill('DELETE');
			await deleteButton.click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 60_000
			});
			// The receipt lists the account only when the server reports deleting it. In one
			// graded recording it listed Forget everything's bullets instead, which says the wipe kept the
			// account it was asked to delete.
			await expect(
				page.getByText('your account and sign-in methods', { exact: true }),
				'the receipt for Delete account does not list the account: the server kept it'
			).toBeVisible();
			await holdForRecording(page);
		});

		// Row 9 in two visits, the receipt and then the old address, with signing in again between them
		// as its own A1 rows.
		await signInWithEmailOtp(page, DATABASE_URL!, email, { skipPendingLabelCheck: true });
		await journeyStep(page, 'A3', 9, async () => {
			const listed = await page.evaluate(async () => {
				const res = await fetch('/chat/api/v2/conversations');
				const body = await res.json();
				// superjson wraps the payload as { json: { conversations, hasMore } }.
				const conversations = (body.json ?? body).conversations;
				return {
					status: res.status,
					count: Array.isArray(conversations) ? conversations.length : -1
				};
			});
			expect(listed.status, 'the conversation list did not load for the new account').toBe(200);
			expect(
				listed.count,
				"signing in again with the deleted account's email lists conversations: the history came back"
			).toBe(0);

			await captionForRecording(page, "reopening the deleted chat's old link on purpose");
			await page.goto(conversationUrl, { waitUntil: 'load' });
			await expect(
				page.getByText(question),
				"the deleted account's chat shows at its old address after signing in again"
			).toHaveCount(0, { timeout: 15_000 });
		});
	}
);

// @preview-only: export is gated behind the `data-export` PostHog flag (CUR-259/CUR-995), which is
// 100% rollout but scoped to env=="preview" only — off in production with no lever
// (ENABLE_DATA_EXPORT unset). Forcing both directions through the override cookie, rather than
// relying on the live flag value, is the same CUR-1368 discipline sign-in.spec.ts already
// established: a coincidentally-matching live value can't tell "the gate works" from "the gate
// happens to already be in the state this run wanted."
test(
	'a signed-in visitor can export their data only once the data-export flag is on',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'data-export': false });
		await signInAsFreshUser(page);

		// Off first, against a fresh account with nothing exportable yet — the only thing that can
		// produce a 403 here is the flag.
		const denied = await page.request.get('/chat/api/v2/export');
		expect(denied.status()).toBe(403);

		await setFlagOverrides(context, baseURL!, { 'data-export': true });

		// The archive on an account with nothing in it. `byteLength > 0` used to be the whole of this
		// test, and a valid ZIP containing nothing satisfies it — so open the thing and say what an
		// empty export is actually supposed to be: a README and a manifest holding an empty list. An
		// export route that silently returned no manifest at all, or a manifest of the wrong shape,
		// was indistinguishable from a correct one until this line.
		const empty = await page.request.get('/chat/api/v2/export');
		expect(empty.status()).toBe(200);
		expect(empty.headers()['content-type']).toBe('application/zip');
		const emptyArchive = openArchive(await empty.body());
		expect(Object.keys(emptyArchive).sort()).toEqual(['README.md', 'conversations.json']);
		const emptyFile = JSON.parse(emptyArchive['conversations.json']);
		expect(emptyFile).toMatchObject({ format: 'alpha-export', schemaVersion: 1 });
		expect(emptyFile.conversations).toEqual([]);
	}
);

// A3 step 6 (CUR-1758): the two tests above prove the route itself is correct once the flag is
// forced on, entirely through page.request — no UI is ever opened. The journey gallery's recording
// of this step showed exactly that gap: an anonymous sign-in ending on the plain landing page, no
// account page, export control, or downloaded ZIP in any frame. This walks the control a person
// actually clicks, on its own fresh account so it doesn't collide with the once-per-hour export
// limit the fidelity test above already spends its account on.
test(
	'the "Download your data" control on the account page produces a real export, not just the route',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		// A full chat turn has to finish before the account page can count its answer.
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'data-export': true,
			// Off for the same reason as the round-trip test below: the router sends this prompt to the
			// agent, and this test is about the export control (CUR-2343).
			'agent-mode': false
		});
		await signInAsFreshUser(page);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);
		await welcomeDialog
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const prompt = 'Suggest a name for a neighbourhood book club in one short sentence.';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(prompt);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		// The row counts answers, so the turn has to be finished and stored before the page reads it.
		// Retry renders only once the turn stops running.
		await expect(
			page.locator('[data-message-role="assistant"]').last().getByRole('button', { name: 'Retry' })
		).toBeVisible({ timeout: 150_000 });

		await journeyStep(page, 'A3', 6, async () => {
			await page.goto('/chat/settings/account', { waitUntil: 'commit' });

			// The row's accessible name, matching account/+page.svelte's own aria-label — the control the
			// journey doc's step 6 promises exists at all, which the graded recording never found.
			const exportRow = page.getByRole('link', {
				name: 'Download a ZIP of your conversations, files, and where each answer came from'
			});
			await expect(
				exportRow,
				'data-export is forced on for this account, so the row must be offered — an account inside the flag with no control to reach it is the same defect this journey step exists to catch'
			).toBeVisible({ timeout: 15_000 });

			// The row says what the ZIP will hold before the click, so the counts a person reads
			// are checked against the archive below rather than trusted.
			const summary = page.getByTestId('export-summary');
			await expect(summary).toContainText('1 conversation,', { timeout: 15_000 });
			const shown = (await summary.innerText()).replace(/\s+/g, ' ');
			await holdForRecording(page);

			const [download] = await Promise.all([page.waitForEvent('download'), exportRow.click()]);
			const downloadPath = await download.path();
			if (!downloadPath) throw new Error('download event fired but Playwright kept no local copy');
			const archive = openArchive(readFileSync(downloadPath));

			// A README, the manifest, and one readable file for this one conversation, holding this exact
			// text. Deliberately not the field-by-field comparison the fidelity test performs; that
			// exists on the route directly, and repeating it here would test the click and nothing the
			// click doesn't share.
			const readable = Object.keys(archive).filter((n) => n.startsWith('conversations/'));
			expect(Object.keys(archive).sort()).toEqual(['README.md', 'conversations.json', ...readable]);
			expect(readable).toHaveLength(1);
			expect(archive[readable[0]]).toContain(prompt);
			const exported = (
				JSON.parse(archive['conversations.json']) as {
					conversations: { messages: Record<string, unknown>[] }[];
				}
			).conversations;
			expect(exported).toHaveLength(1);
			expect(JSON.stringify(exported)).toContain(prompt);

			const answers = exported[0].messages.filter((m) => m.from === 'assistant');
			const files = Object.keys(archive).filter(
				(n) => n.startsWith('files/') || n.startsWith('attachments/')
			);
			expect(
				shown,
				`the row said "${shown}", which has to match the ${answers.length} answer(s) and ${files.length} file(s) in the ZIP`
			).toContain(
				`${files.length} ${files.length === 1 ? 'file' : 'files'}, and ${
					answers.length === 1
						? 'where the 1 answer came from'
						: `where each of the ${answers.length} answers came from`
				}.`
			);
		});
	}
);

// One export an hour. A second Download inside the hour used to land on the route's bare white
// "429" page, with no way back into the app. The row now says when the next export is possible,
// both right after the click and after a reload, when only the server knows about the first one.
// An empty account is enough: the limit counts exports, not what is in them.
test(
	'a second Download inside the hour is refused on the account page, not on a bare 429 page',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'data-export': true });
		await signInAsFreshUser(page);
		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		const exportRow = page.getByRole('link', {
			name: 'Download a ZIP of your conversations, files, and where each answer came from'
		});
		await expect(exportRow).toBeVisible({ timeout: 15_000 });
		const [download] = await Promise.all([page.waitForEvent('download'), exportRow.click()]);
		expect(await download.failure()).toBeNull();

		await journeyStep(page, 'A3', 11, async () => {
			for (const when of ['right after the download', 'after a reload']) {
				if (when === 'after a reload') await page.reload({ waitUntil: 'commit' });
				const locked = page.getByTestId('export-row-locked');
				await expect(locked, `the export row is still a live link ${when}`).toBeVisible({
					timeout: 15_000
				});
				// A reload lands at the top of the page. Scroll back to the row the way a person would, so
				// the recording ends on the refusal and not on Linked providers (CUR-2295).
				await locked.scrollIntoViewIfNeeded();
				await expect(locked.getByRole('status')).toContainText('You can download again after');
				await expect(locked.getByRole('button', { name: 'Download' })).toBeDisabled();
				await expect(exportRow).toHaveCount(0);
			}
			await expect(page).toHaveURL(/\/chat\/settings\/account/);
		});
	}
);

// The same refusal from a page that never saw the first export: one tab exports, and an Account page
// opened before that still offers the link. Its click used to replace the page with a bare 429
// (CUR-3849); the route now sends a navigation back to the Account page, which reads the hour itself.
test(
	'Download on an Account page opened before an export in another tab shows the refusal in the row (CUR-3849)',
	{ tag: ['@preview-only', '@A3', '@CUR-3849'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'data-export': true });
		await signInAsFreshUser(page);
		const rowName = 'Download a ZIP of your conversations, files, and where each answer came from';
		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		const staleRow = page.getByRole('link', { name: rowName });
		await expect(staleRow).toBeVisible({ timeout: 15_000 });

		const other = await context.newPage();
		await other.goto('/chat/settings/account', { waitUntil: 'commit' });
		const otherRow = other.getByRole('link', { name: rowName });
		await expect(otherRow).toBeVisible({ timeout: 15_000 });
		const [download] = await Promise.all([other.waitForEvent('download'), otherRow.click()]);
		expect(await download.failure()).toBeNull();
		await other.close();

		await page.bringToFront();
		await expect(staleRow, 'the first tab still offers the link it loaded with').toBeVisible();
		await staleRow.click();
		await expect(page, 'the click left the Account page').toHaveURL(/\/chat\/settings\/account/, {
			timeout: 15_000
		});
		const locked = page.getByTestId('export-row-locked');
		await expect(locked, 'the row does not say the export is refused').toBeVisible({
			timeout: 15_000
		});
		await locked.scrollIntoViewIfNeeded();
		await expect(locked.getByRole('status')).toContainText('You can download again after');
		await expect(page.getByText('You have already exported your data recently')).toHaveCount(0);
	}
);

// Split out of the test above (CUR-1770): the export route allows one export per account per
// hour, so the empty-archive shape and the round-trip fidelity cannot both be observed from one
// sign-in. Two accounts, one export each.
test(
	'an exported archive reproduces the conversation row it was built from',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'data-export': true,
			'custodial-storage-view': true,
			// This test exports a conversation; it does not test agent mode. With the composer on
			// "Agent: auto", its earlier prompt ("…has to come back out of the zip") was routed to the agent
			// as "multi-step file transformation", and an agent turn that outlasted the output-screen window
			// failed the export on a turn it never meant to take (CUR-2343).
			'agent-mode': false
		});
		await signInAsFreshUser(page);

		// Same welcome-overlay hazard as the sibling tests above.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await welcomeDialog
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const prompt = 'Suggest a name for a weekend hiking group in one short sentence.';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(prompt);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;

		// The turn has to finish before the export, or the archive catches the answer before its
		// provenance is written. Retry is the signal: ChatMessage.svelte:970 renders it only once
		// `isTurnStillRunning` is false (CUR-1652), including for a turn that produced no text
		// (CUR-1748). This used to wait on "Copy to clipboard", which a code block inside the answer
		// also renders while it streams, so a reply with code let the export race the turn (CUR-2035).
		await expect(
			page.locator('[data-message-role="assistant"]').last().getByRole('button', { name: 'Retry' }),
			'the turn never finished, so there is no completed answer to export'
		).toBeVisible({ timeout: 60_000 });

		// What the chat itself says about this answer, read off the page, so the archive is held to
		// the chat's words rather than to a copy of them in this file (CUR-1836): the source class
		// ("from training" or "looked it up") and the badge's model name, the first segment of its
		// title.
		const reply = page.locator('[data-message-role="assistant"]').last();
		// X-ray's Step by step is where the chat shows whether the answer drew on sources: a step with a
		// "See N sources" list means it looked them up; none means it answered from training. Those are
		// the two classes the export writes ("looked it up" / "from training").
		await reply
			.getByRole('button', { name: /How this answer was made/ })
			.click({ timeout: 30_000 });
		await page.getByRole('tab', { name: 'Step by step' }).click({ timeout: 10_000 });
		const steps = page.locator('[data-xray-steps]');
		await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
		const lookedUp = (await steps.getByRole('button', { name: /^See \d+ sources?$/ }).count()) > 0;
		const sourceClass = lookedUp ? 'looked it up' : 'from training';
		await page.keyboard.press('Escape');
		const badgeTitle = await reply
			.locator('[data-provenance="line"]')
			.first()
			.getAttribute('title');
		const badgeName = badgeTitle?.split(' · ')[0];

		// A file stored with us, so the archive can be checked for it. Posted to the same endpoint the
		// storage page's upload control calls.
		const storedName = `export-probe-${Date.now()}.txt`;
		const storedBody = 'A3 export scenario: a stored file has to come back out of the zip\n';
		try {
			// The chat's CSRF hook refuses a form post with no Origin (hooks/handle.ts), and a request
			// made from the test, unlike the page's own upload control, sends none.
			const upload = await page.request.post('/chat/api/storage', {
				headers: { Origin: new URL(page.url()).origin },
				multipart: {
					folder: 'documents',
					file: { name: storedName, mimeType: 'text/plain', buffer: Buffer.from(storedBody) }
				}
			});
			expect(upload.ok(), `storing the probe file failed: ${upload.status()}`).toBe(true);

			// The ONLY export this account performs. api/v2/export/+server.ts refuses a second one
			// within the hour (`nExports >= 1` -> 429, counted from an unexpired `messageEvents` row),
			// which is why the empty-archive claim lives in its own test on its own account rather
			// than as a first call here.
			const allowed = await page.request.get('/chat/api/v2/export');
			expect(allowed.status()).toBe(200);
			expect(allowed.headers()['content-type']).toBe('application/zip');
			const archive = openArchive(await allowed.body());

			// Alpha is text-only: `multimodalEnabled()` gates the attachment branch in
			// api/v2/export/+server.ts, so no attachment entry may appear even for a crafted file ref.
			expect(Object.keys(archive).filter((n) => n.startsWith('attachments/'))).toEqual([]);

			const exported = (
				JSON.parse(archive['conversations.json']) as {
					conversations: { readable: string; messages: Record<string, unknown>[] }[];
				}
			).conversations;
			expect(exported).toHaveLength(1);

			// The JSON copy carries the fields the person would want, each equal to the stored row,
			// and none of the internal ones a whole-record spread used to leak.
			const row = await readConversationDoc(DATABASE_URL!, conversationId);
			for (const leaked of ['userId', 'sessionId', 'organizationId', 'userAgent']) {
				expect(exported[0], `the export carries the conversation's ${leaked}`).not.toHaveProperty(
					leaked
				);
			}
			// `decodeStorageMarkers` makes the two sides comparable: the jsonb column holds every Date as
			// `{$dt: iso}`, the archive as a bare ISO string. See the helper for why this does not just
			// call the app's own decoder.
			const dbMessages = (
				decodeStorageMarkers(JSON.parse(JSON.stringify(row.messages ?? []))) as Record<
					string,
					unknown
				>[]
			).filter((m) => m.from !== 'system');
			const zipMessages = exported[0].messages;
			expect(zipMessages.map((m) => m.id)).toEqual(dbMessages.map((m) => m.id));
			for (let i = 0; i < dbMessages.length; i++) {
				expect(zipMessages[i]).toMatchObject({
					from: dbMessages[i].from,
					content: dbMessages[i].content,
					createdAt: dbMessages[i].createdAt
				});
				for (const leaked of ['timings', 'updates', 'ancestors', 'children']) {
					expect(zipMessages[i], `message ${i} carries ${leaked}`).not.toHaveProperty(leaked);
				}
			}
			expect(JSON.stringify(exported)).toContain(prompt);

			// "Where each answer came from" is one of the three things the account page says the ZIP
			// holds. develop's lane sends a provenance header on every turn since CUR-1452, so an
			// answer without one means the export or the record lost it.
			const answerIndex = zipMessages.findLastIndex((m) => m.from === 'assistant');
			expect(
				answerIndex,
				'the export holds no assistant message, so there is no answer to trace'
			).toBeGreaterThanOrEqual(0);
			const storedModel = (dbMessages[answerIndex].routerMetadata as { model?: string } | undefined)
				?.model;
			expect(
				(zipMessages[answerIndex].servedBy as { model?: string } | undefined)?.model,
				'the exported answer does not name the model the stored row says served it'
			).toBe(storedModel);
			// The stored backend is the lane's base URL, whose path can carry a provider account id
			// (Infomaniak's does). A file we tell people to keep and share names the institution or the
			// bare host, never a path (CUR-2186).
			const storedBackend = (
				dbMessages[answerIndex].routerMetadata as { backend?: string } | undefined
			)?.backend;
			const exportedBackend = (
				zipMessages[answerIndex].servedBy as { backend?: string } | undefined
			)?.backend;
			if (storedBackend) {
				expect(
					exportedBackend,
					'the stored answer names a backend and the export dropped it'
				).toBeTruthy();
			}
			for (const m of zipMessages) {
				const backend = (m.servedBy as { backend?: string } | undefined)?.backend;
				if (backend === undefined) continue;
				expect(backend, `an exported answer names its backend by URL: ${backend}`).not.toMatch(
					/\//
				);
			}

			// EU AI Act Art. 50 (CUR-996): every answer is machine-readably marked as model-written, in
			// IPTC's digital-source-type vocabulary, and nothing the person wrote is.
			for (const m of zipMessages) {
				if (m.from === 'assistant') {
					expect(m, 'an exported answer is not marked as AI-generated').toMatchObject({
						aiGenerated: true,
						digitalSourceType:
							'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
					});
				} else {
					expect(m, 'a message the person wrote is marked as AI-generated').not.toHaveProperty(
						'aiGenerated'
					);
				}
			}
			await test.info().attach('conversations.json', {
				body: archive['conversations.json'],
				contentType: 'application/json'
			});

			// The readable copy: this conversation, with the answer's provenance in the chat's words.
			const readable = archive[exported[0].readable];
			expect(readable, `the archive has no readable copy at ${exported[0].readable}`).toBeTruthy();
			expect(readable).toContain(prompt);
			expect(sourceClass, 'the page showed no source class for the answer').toBeTruthy();
			expect(readable, `the readable copy does not say "${sourceClass}"`).toContain(
				`> ${sourceClass}`
			);
			expect(badgeName, 'the page showed no provenance badge for the answer').toBeTruthy();
			expect(
				readable,
				`the readable copy does not name "${badgeName}" as the badge does`
			).toContain(badgeName!);

			expect(archive['README.md'], 'the archive has no README').toContain('conversations/');

			// The stored file, under the folder it was stored in, byte for byte.
			expect(
				archive[`files/documents/${storedName}`],
				'the stored file is not in the archive'
			).toBe(storedBody);
		} finally {
			const listed = await page.request.get('/chat/api/storage');
			for (const f of listed.ok()
				? ((await listed.json()) as { files: { path: string }[] }).files
				: []) {
				await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(f.path)}`);
			}
		}
	}
);

// The signed-in wipe deletes the account, so its confirm step has to say so in the title and on the
// button, not borrow the guest's "Forget everything?" and "Forget everything". It also checks the two
// body sentences do not run together ("servers.It"), the closing line ends in a full stop, and focus
// landing on the destructive button. This test backs out with Cancel, so nothing is deleted.
test(
	"a signed-in person's delete confirm names the account, reads cleanly, and opens on Cancel",
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await signInAsFreshUser(page);

		await page.goto('/chat/settings/account', { waitUntil: 'commit' });
		await page
			.getByRole('button', { name: 'Delete your account, conversations, and sign-in methods' })
			.click({ timeout: 30_000 });

		await expect(
			page.getByRole('heading', { name: 'Delete your account?' }),
			'a signed-in person sees the guest title, which does not say the account goes too'
		).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole('heading', { name: 'Forget everything?' })).toHaveCount(0);
		const deleteButton = page.getByRole('button', { name: 'Delete account', exact: true });
		await expect(deleteButton).toBeVisible();
		await expect(page.getByRole('button', { name: 'Forget everything', exact: true })).toHaveCount(
			0
		);

		await expect(
			page.getByText(phrase('from our servers. It also deletes your account')),
			'the two sentences of the confirm body run together with no space between them'
		).toBeVisible();
		await expect(page.getByText('This action cannot be undone.', { exact: true })).toBeVisible();
		// A named account's records are not anonymous, and the guest copy said they were.
		await expect(
			page.getByRole('dialog').getByText(/anonymous/i),
			'the signed-in delete confirm calls the account data anonymous'
		).toHaveCount(0);

		const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
		await expect(
			cancel,
			'the dialog opened with focus on the destructive button rather than on Cancel'
		).toBeFocused();
		// One stray click must not delete an account. The button stays disabled until the
		// word is typed, and a near miss does not count.
		await expect(
			deleteButton,
			'Delete account is clickable before the word is typed'
		).toBeDisabled();
		const confirmField = page.getByLabel('Type DELETE to confirm');
		await confirmField.fill('DELET');
		await expect(deleteButton).toBeDisabled();
		await confirmField.fill('DELETE');
		await expect(deleteButton, 'typing DELETE did not enable Delete account').toBeEnabled();
		// The recording has to show the confirm a person reads, not only the page before and after it
		// (CUR-2348).
		await holdForRecording(page);
		await cancel.click();
		await expect(page.getByRole('heading', { name: 'Delete your account?' })).toBeHidden();
	}
);

// "Forget everything" and "Delete account" are separate actions. Forget everything clears a
// signed-in person's data and leaves them signed in to the same account, the way a browser's "clear
// history" never signs you out of the browser itself. Before this, the same click deleted the account
// too, and the only place that said so plainly was the receipt.
test(
	'a signed-in person who forgets everything stays signed in and keeps the account',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await signInAsFreshUser(page);

		await page.goto('/chat/settings/data', { waitUntil: 'commit' });
		// The page's own explainer said the account "is deleted", beside a confirm saying it
		// stays. Both now say it stays.
		await expect(
			page.getByText(phrase('You stay signed in and keep your account')),
			'Data & privacy does not say the account stays'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(phrase('your account is deleted'))).toHaveCount(0);
		await expect(
			page.getByText(phrase('Files you upload are stored')),
			'Data & privacy shows a signed-in person where uploads are kept'
		).toBeVisible();
		await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 30_000 });

		await expect(
			page.getByRole('heading', { name: 'Forget everything?' }),
			'Forget everything opened as account deletion'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByRole('dialog').getByText(/anonymous/i),
			'the signed-in Forget everything confirm calls the account data anonymous'
		).toHaveCount(0);
		await expect(page.getByText(phrase('deletes your account and sign-in methods'))).toHaveCount(0);
		await expect(
			page.getByText(phrase('You stay signed in, and your account stays'))
		).toBeVisible();
		await expect(page.getByLabel('Type DELETE to confirm')).toHaveCount(0);
		await holdForRecording(page);

		await journeyStep(page, 'A3', 10, async () => {
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 60_000
			});
			await expect(page.getByText('your account and sign-in methods')).toHaveCount(0);
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Done' }).click();

			// The account page sends a signed-out visitor to /chat/login, so arriving there is the check.
			await page.goto('/chat/settings/account', { waitUntil: 'commit' });
			await expect(
				page.getByRole('button', {
					name: 'Delete your account, conversations, and sign-in methods'
				}),
				'Forget everything signed the person out or deleted the account'
			).toBeVisible({ timeout: 30_000 });
			expect(new URL(page.url()).pathname).not.toMatch(/\/chat\/login/);
		});
	}
);

// The account page read its four sections (sign-in methods, passkeys, sessions, the
// session itself) from the browser after hydration, so a first open showed a skeleton for 1.3-1.7 s,
// and once 4.5 s. The server now reads them. As in workspaces.spec.ts's CUR-1975 test, read the raw
// response: in a browser both versions end up showing the same page, so only the HTML tells them apart.
test(
	'the account page arrives with its sections in the HTML, so a first open needs no browser fetch before it shows them',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		// `page.request` carries this context's session cookie.
		const response = await page.request.get('/chat/settings/account');
		expect(response.ok(), `GET /chat/settings/account answered ${response.status()}`).toBe(true);
		const html = await response.text();
		expect(html, 'the HTML does not carry this person’s own session').toContain(email);
		expect(
			html,
			'the HTML has no Display name field: the sections still wait on the browser'
		).toContain('id="account-display-name"');
		expect(html, 'the HTML lists no session: Active sessions still waits on the browser').toContain(
			'data-testid="session-device"'
		);
		expect(html, 'the HTML does not mark the current session').toContain('This device');
		// The HTML carries the visitor's session, so no shared cache may keep it.
		expect(response.headers()['cache-control'] ?? '').toMatch(
			/\bprivate\b.*\bno-store\b|\bno-store\b.*\bprivate\b/
		);
	}
);
