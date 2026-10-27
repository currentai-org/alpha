// e2e-product: @chat
// e2e-area: @storage
import { test, expect } from './helpers/test';
import type { Locator, Page } from '@playwright/test';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import {
	accountButton,
	accountMenuItem,
	openWorkspaceSettings,
	workspaceFlyout
} from './helpers/accountMenu';
import { holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { chatEntry } from './helpers/chatEntry';
import { expectReadOnlyFormerChat, viewFormerWorkspace } from './helpers/formerWorkspace';
import { startChattingPastWelcome } from './helpers/welcome';

// @preview-only: workspaces are reached here by forcing three flags through the fuzz override
// cookie, which production deliberately does not wire. Scoped at the runner rather than skipped in
// the body — see sign-in.spec.ts's note on why a skip is the wrong shape.
test(
	'a zero-org signed-in visitor can create a workspace and see it as Current',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		// A8 step 1 is "opens workspace settings for the first time", so the test opens them the way a
		// person does, from the account menu, rather than typing the URL. The welcome dialog a fresh
		// account lands on would otherwise sit over the menu.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await journeyStep(page, 'A8', 1, async () => {
			await openWorkspaceSettings(page, { timeout: 30_000 });
			await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
			// Real network round-trips (getSession + organization.list()) block this heading, same shape as
			// sign-in.spec.ts's OTP wait — Playwright's 5s default underestimates that chain against a cold
			// per-PR preview. First attempt at 15s (CUR-1163) still wasn't enough: two independent CI runs
			// timed out at 15000ms with the render landing at 17.5s/18.5s BOTH times, not a one-off cold-start
			// (unlike chat-message-send.spec.ts's sibling failure in the same runs, which passed clean on
			// retry — that one's a genuine one-shot cold start; this one consistently needs more room). 30s
			// clears the observed worst case with margin, well under the suite's own 60s per-test ceiling.
			await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
				timeout: 30_000
			});
			// The empty form is the step's own screen; typing into it at once left no frame of it (CUR-2289).
			await holdForRecording(page);
		});

		await journeyStep(page, 'A8', 2, async () => {
			const name = `E2E Workspace ${Date.now()}`;
			const nameInput = page.getByPlaceholder("Your organisation or group's name");
			await nameInput.fill(name);

			// Between the create succeeding and the reloaded list arriving, the page must still
			// read as "creating this workspace" (CUR-1560). The grader saw the field blank to its placeholder there,
			// and before that a bare "+ New workspace" with an empty list. That window is a few hundred ms
			// on a warm preview, too short to assert on, so the list reload that follows the create is held
			// until the assertions below have run.
			let created = false;
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			let reloadStarted!: () => void;
			const reloading = new Promise<void>((r) => (reloadStarted = r));
			await page.route('**/api/auth/organization/create', async (route) => {
				const response = await route.fetch();
				created = response.ok();
				await route.fulfill({ response });
			});
			await page.route('**/api/auth/organization/list*', async (route) => {
				if (created) {
					reloadStarted();
					await held;
				}
				await route.continue();
			});

			await page.getByRole('button', { name: 'Create' }).click();
			await reloading;
			await expect(page.getByRole('button', { name: 'Creating…' })).toBeVisible();
			await expect(
				nameInput,
				'the typed name was cleared while the workspace was still being created'
			).toHaveValue(name);
			await expect(
				page.getByRole('button', { name: 'New workspace' }),
				'the form collapsed to "+ New workspace" before the new workspace was listed'
			).toBeHidden();
			// Unrouting while the held list request is still pending makes Playwright let it go itself, so
			// the handler's own continue then throws (CUR-3373). Let it answer first.
			const listAnswered = page.waitForResponse((r) =>
				r.url().includes('/api/auth/organization/list')
			);
			release();
			await listAnswered;
			await page.unroute('**/api/auth/organization/list*');
			await page.unroute('**/api/auth/organization/create');

			// getByText('Current') alone strict-mode-fails: it substring-matches the footer's "Current AI"
			// link too (seen on a migrated preview branch). Scope to
			// the workspace switcher button itself and require an exact match on its "Current" badge span.
			// Same class of wait as :31's heading — Create triggers a write plus an org-list refetch, and
			// Playwright's 5s default caught this cold on CI (element not found at 5000ms, passed on retry).
			// 15s matches the margin already given to the invite/cancel
			// round trips below rather than inventing a new number.
			const workspaceButton = page.getByRole('button', { name });
			await expect(workspaceButton).toBeVisible({ timeout: 15_000 });
			await expect(workspaceButton.getByText('Current', { exact: true })).toBeVisible({
				timeout: 15_000
			});
		});

		// CUR-1699: invite/remove/usage (CUR-550, Done) have never been exercised — continuing in the
		// same test rather than a fresh one, since `createWorkspace()` already calls `selectOrg()` (see
		// +page.svelte:301-303), so the admin view with these sections is already loaded here with no
		// second sign-in or creation needed. Not CUR-964/965/966: those gate WHO can reach step 1 and are
		// still In Review/Todo; invite/usage exist regardless of that gate.
		// A8 step 3. Each of these screens went by in a few hundred ms, so the grader never saw the
		// address typed, listed as pending, or cancelled (CUR-2386). Each gets a hold once asserted.
		const inviteeEmail = freshTestEmail();
		const inviteField = page.getByPlaceholder('name@example.org');
		const pendingRow = page.getByText(inviteeEmail, { exact: true });
		await journeyStep(page, 'A8', 3, async () => {
			await inviteField.fill(inviteeEmail);
			await expect(inviteField).toHaveValue(inviteeEmail);
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Invite' }).click();

			await expect(pendingRow, 'the invite never landed in Pending invitations').toBeVisible({
				timeout: 15_000
			});
			await holdForRecording(page);
		});

		// A bare getByRole('button', { name: 'Cancel' }) is unambiguous here: it's the only "Cancel"
		// label anywhere on this page (Danger zone's own control reads "Delete workspace…", not
		// "Cancel") and this test creates exactly one invitation.
		await journeyStep(page, 'A8', 4, async () => {
			await page.getByRole('button', { name: 'Cancel' }).click();
			await expect(pendingRow, 'cancelling the invitation left it in the pending list').toBeHidden({
				timeout: 15_000
			});
			await holdForRecording(page);
		});

		// Filling the invite field scrolled the settings panel down, and cancelling shortened
		// it, so the recording ended with the member row cut off under the tab row (CUR-1885). The journey critic
		// kept filing that as a layout bug. A person who just created a workspace looks at it from the
		// top, so the test goes back there and checks that the row naming them as admin is whole
		// inside the scroll area.
		await journeyStep(page, 'A8', 5, async () => {
			const memberRow = page.getByTestId('workspace-member').filter({ hasText: email });
			await expect(memberRow).toContainText(`${email} · Admin`);
			const { row, panel } = await memberRow.evaluate((el) => {
				let scroller = el.parentElement;
				while (scroller && getComputedStyle(scroller).overflowY !== 'auto') {
					scroller = scroller.parentElement;
				}
				if (!scroller) throw new Error('no scrolling ancestor above the member row');
				scroller.scrollTop = 0;
				const r = el.getBoundingClientRect();
				const p = scroller.getBoundingClientRect();
				return { row: { top: r.top, bottom: r.bottom }, panel: { top: p.top, bottom: p.bottom } };
			});
			expect(
				row.top,
				'the member row starts above the settings panel, under the tab row'
			).toBeGreaterThanOrEqual(panel.top);
			expect(
				row.bottom,
				'the member row runs past the bottom of the settings panel'
			).toBeLessThanOrEqual(panel.bottom);

			// Usage is admin-only (+page.svelte's `{#if isAdmin}`) — the creator is admin automatically, so
			// this asserts the panel itself renders real numbers, not a stuck "Loading…"/error state. Exact
			// counts are workspaceUsage.spec.ts's job, not this journey's: a brand-new workspace legitimately
			// reads 0 conversations, and asserting that literal would break the day someone seeds fixture data.
			await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
			await expect(page.getByText('Conversations', { exact: true })).toBeVisible();
			await expect(page.getByText('Messages', { exact: true })).toBeVisible();
			await expect(page.getByText('Active in the last 30 days', { exact: true })).toBeVisible();
		});
	}
);

// A8 steps 6-8, CUR-553: a person can belong to several workspaces,
// "always see which one they are in", and switch. CUR-827: an admin can delete everything the
// workspace holds, at once. Switching goes through Better Auth's own active organization, so the
// reload below is what proves the switch reached the server rather than only this page's state.
test(
	'a person in two workspaces always sees which one is current, switching survives a reload, and deleting the current one lands them in Personal, and a new workspace is listed only once it is the Current one (CUR-3462, CUR-3948)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await openWorkspaceSettings(page, { timeout: 30_000 });
		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });

		const stamp = Date.now();
		const first = `E2E First ${stamp}`;
		const second = `E2E Second ${stamp}`;
		const nameInput = page.getByPlaceholder("Your organisation or group's name");
		// Each workspace's row in "Your workspaces" is a button named by the workspace, and the current
		// one carries a "Current" badge inside it. Exact on the badge: the footer's "Current AI" link
		// matches a substring search.
		const row = (name: string) => page.getByRole('button', { name });
		const isCurrent = (name: string) => row(name).getByText('Current', { exact: true });
		// The sidebar's account row names the current workspace, so the chat says where new
		// conversations count without opening Settings (CUR-3014).
		const accountStatus = accountButton(page).locator('[data-account-status]');

		await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
			timeout: 30_000
		});
		await nameInput.fill(first);
		// After Create the new row lit up at once while Personal kept Current and the heading,
		// for the ~2 s the new workspace's detail took to load (graded recordings caught it) (CUR-3462).
		// Hold that load: nothing is highlighted until the new workspace is Current.
		{
			let releaseDetail!: () => void;
			const detailHeld = new Promise<void>((resolve) => (releaseDetail = resolve));
			const detail = '**/chat/api/auth/organization/get-full-organization*';
			await page.route(detail, async (route) => {
				await detailHeld;
				await route.continue();
			});
			const detailAsked = page.waitForRequest((r) =>
				r.url().includes('/chat/api/auth/organization/get-full-organization')
			);
			const listAnswered = page.waitForResponse(
				(r) => r.url().includes('/chat/api/auth/organization/list'),
				{ timeout: 15_000 }
			);
			await page.getByRole('button', { name: 'Create', exact: true }).click();
			await detailAsked;
			expect((await listAnswered).status(), 'the reloaded workspace list failed').toBe(200);
			// The reloaded list was shown on its own, so the new row sat there unmarked while
			// Personal was still Current (CUR-3948). It now arrives in the same step as the Current mark.
			// Sampled for a second while the detail is held: a retrying toHaveCount(0) would pass in the
			// moment before the list rendered.
			for (let sample = 0; sample < 10; sample++) {
				expect(
					await row(first).count(),
					'the new workspace was listed while Personal was still Current'
				).toBe(0);
				await page.waitForTimeout(100);
			}
			const detailAnswered = page.waitForResponse((r) =>
				r.url().includes('/chat/api/auth/organization/get-full-organization')
			);
			releaseDetail();
			expect((await detailAnswered).status(), 'the held workspace detail failed to load').toBe(200);
			await page.unroute(detail);
		}
		await expect(isCurrent(first)).toBeVisible({ timeout: 15_000 });
		await expect(row(first), 'the highlight did not follow the new workspace').toHaveClass(
			/bg-white\/15/
		);
		// Read once, with no retry: the badge and the account row move in one step.
		expect(
			(await accountStatus.textContent())?.trim(),
			'the new workspace was marked Current while the account row still named Personal'
		).toBe(first);

		// Step 6. A second workspace, made from the same screen.
		await journeyStep(page, 'A8', 6, async () => {
			await page.getByRole('button', { name: 'New workspace' }).click();
			await expect(page.getByRole('heading', { name: 'Create another workspace' })).toBeVisible();
			await nameInput.fill(second);
			await expect(nameInput).toHaveValue(second);
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Create', exact: true }).click();
			await expect(
				row(first),
				'the first workspace left the list when a second was made'
			).toBeVisible({
				timeout: 15_000
			});
			await expect(
				isCurrent(second),
				'a newly made workspace is the one the person is in'
			).toBeVisible({
				timeout: 15_000
			});
			await expect(isCurrent(first), 'two workspaces are marked Current at once').toHaveCount(0);
			await expect(
				accountStatus,
				'the account row does not name the workspace just made current'
			).toHaveText(second, { timeout: 15_000 });
			// The create form sits below the workspace list, so after Create the screen still
			// showed the new workspace's members and Danger zone, and the grader never saw both rows with
			// one Current badge (CUR-2581). The hold films the list instead.
			await page
				.getByRole('heading', { name: 'Your workspaces', exact: true })
				.scrollIntoViewIfNeeded();
			await expect(row(first)).toBeInViewport();
			await expect(row(second)).toBeInViewport();
			await holdForRecording(page);
		});

		// Step 7. One click switches, the badge follows, and a reload keeps it.
		await journeyStep(page, 'A8', 7, async () => {
			// The badge moved as soon as the switch answered, while the name, rules and
			// members below still showed the old workspace until its detail loaded (CUR-3373). Hold that load: the
			// badge waits with the panel, and both change together.
			let releaseDetail!: () => void;
			const detailHeld = new Promise<void>((resolve) => (releaseDetail = resolve));
			const detail = '**/chat/api/auth/organization/get-full-organization*';
			await page.route(detail, async (route) => {
				await detailHeld;
				await route.continue();
			});
			const switched = page.waitForResponse((r) =>
				r.url().includes('/chat/api/auth/organization/set-active')
			);
			// The page asks for the detail only after it has taken the switch in, so once that request
			// is out, whatever the badge shows is what the page decided.
			const detailAsked = page.waitForRequest((r) =>
				r.url().includes('/chat/api/auth/organization/get-full-organization')
			);
			await row(first).click();
			expect((await switched).status(), 'the switch was refused').toBe(200);
			await detailAsked;
			await expect(
				isCurrent(second),
				'the list marked the new workspace current while the panel below still showed the old one'
			).toBeVisible();
			await expect(isCurrent(first)).toHaveCount(0);
			// The clicked row lit up at once while Current stayed on the other row, so for the
			// length of the detail load the list named two workspaces (CUR-3462). The highlight waits with the badge.
			// `bg-white/15` is the highlight the person sees; the row has no other selected state.
			await expect(
				row(first),
				'the clicked row was highlighted while Current still sat on the other workspace'
			).not.toHaveClass(/bg-white\/15/);
			await expect(row(second)).toHaveClass(/bg-white\/15/);
			await expect(
				row(first).getByText('Switching…'),
				'the clicked row gave no sign it heard the click while the switch loaded'
			).toBeVisible();
			// Unrouting while the held request is still pending makes Playwright let it go itself, so the
			// handler's own continue then throws and the detail load fails. Let it answer first.
			const detailAnswered = page.waitForResponse((r) =>
				r.url().includes('/chat/api/auth/organization/get-full-organization')
			);
			releaseDetail();
			expect((await detailAnswered).status(), 'the held workspace detail failed to load').toBe(200);
			await page.unroute(detail);
			await expect(
				isCurrent(first),
				'clicking a workspace did not make it the current one'
			).toBeVisible({
				timeout: 15_000
			});
			await expect(isCurrent(second)).toHaveCount(0);
			await expect(row(first), 'the highlight did not follow the switch').toHaveClass(
				/bg-white\/15/
			);
			await expect(row(second)).not.toHaveClass(/bg-white\/15/);
			await expect(
				accountStatus,
				'after a switch the account row still names the previous workspace'
			).toHaveText(first, { timeout: 15_000 });
			await holdForRecording(page);
			await page.reload({ waitUntil: 'commit' });
			await expect(
				isCurrent(first),
				'after a reload the switch was forgotten, so it never reached the server'
			).toBeVisible({ timeout: 30_000 });
			await expect(
				accountStatus,
				'after a reload the account row lost the current workspace'
			).toHaveText(first);
			await holdForRecording(page);
		});

		// Step 8. Delete the current workspace. The confirm asks for its name, and afterwards the person
		// is in Personal, told why, and no team workspace is picked for them (CUR-3022).
		await journeyStep(page, 'A8', 8, async () => {
			await page.getByRole('button', { name: 'Delete workspace…' }).click();
			await page.getByPlaceholder(first, { exact: true }).fill(first);
			await holdForRecording(page);
			await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
			await expect(row(first), 'the deleted workspace is still listed').toHaveCount(0, {
				timeout: 15_000
			});
			// Scoped to the list: the sidebar's account button also reads "Personal workspace".
			const list = page
				.locator('section')
				.filter({ has: page.getByRole('heading', { name: 'Your workspaces', exact: true }) });
			const personalCurrent = list
				.getByRole('button', { name: 'Personal workspace' })
				.getByText('Current', { exact: true });
			await expect(
				personalCurrent,
				'after deleting the current workspace, Personal is not the current one'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				isCurrent(second),
				'deleting the current workspace moved the person into another team workspace'
			).toHaveCount(0);
			await expect(list.getByRole('status')).toContainText(`${first} was deleted`);
			await expect(
				accountStatus,
				'after deleting the current workspace, the account row does not say Personal'
			).toHaveText('Personal workspace', { timeout: 15_000 });
			await expectPersonalPanel(page, 'after deleting the current workspace');
			await holdForRecording(page);
		});
	}
);

// Under Personal the panel below the list describes no team workspace, so the list and the
// panel never name different workspaces, and a line says where the person is (CUR-3373).
const PERSONAL_PANEL_COPY =
	"You're in your personal workspace. Choose a workspace above to see its members and rules.";
async function expectPersonalPanel(
	page: Page,
	when: string,
	opts: { timeout: number } = { timeout: 15_000 }
) {
	await expect(
		page.getByText(PERSONAL_PANEL_COPY),
		`${when}, the panel does not say the person is in Personal`
	).toBeVisible({ timeout: opts.timeout });
	await expect(
		page.getByTestId('workspace-member'),
		`${when}, Personal is current but the panel lists a team workspace's members`
	).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Workspace rules' })).toHaveCount(0);
}

// A session starts with no active workspace, which the chat calls "Personal workspace" (CUR-3020).
// Opening Settings → Workspace took that for a workspace deleted under the person (CUR-2835) and
// made their first workspace current, so looking at the page moved them out of Personal.
test(
	'opening Settings → Workspace leaves a person in their personal workspace, and they can switch in and back',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		// The scene: a member of one workspace who is in Personal, the state a fresh sign-in leaves.
		const name = `E2E Team ${Date.now()}`;
		const post = async (path: string, data: object) => {
			const res = await page.request.post(`/chat/api/auth/organization/${path}`, {
				data,
				headers: { origin: new URL(baseURL!).origin }
			});
			expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
		};
		await post('create', { name, slug: name.toLowerCase().replace(/\W+/g, '-') });
		await post('set-active', { organizationId: null });
		await page.reload({ waitUntil: 'commit' });

		const accountStatus = accountButton(page).locator('[data-account-status]');
		// Scoped to the list: the sidebar's account button also reads "Personal workspace".
		const list = page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Your workspaces', exact: true }) });
		const row = (label: string) => list.getByRole('button', { name: label });
		const isCurrent = (label: string) => row(label).getByText('Current', { exact: true });
		await expect(accountStatus).toHaveText('Personal workspace', { timeout: 30_000 });

		await openWorkspaceSettings(page, { timeout: 30_000 });
		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
		// The Personal line shows once the page knows nothing is active, after any switch it makes on
		// its own, so once it shows, a reload reads what the server now holds.
		await expectPersonalPanel(page, 'on opening the page in Personal', { timeout: 30_000 });
		await page.reload({ waitUntil: 'commit' });
		await expect(row(name)).toBeVisible({ timeout: 30_000 });
		await expect(
			accountStatus,
			'opening Settings → Workspace moved the person out of their personal workspace'
		).toHaveText('Personal workspace');
		await expect(
			isCurrent('Personal workspace'),
			'the page does not show Personal as the current workspace'
		).toBeVisible({ timeout: 15_000 });
		await expect(isCurrent(name), 'opening the page made a workspace current').toHaveCount(0);

		// The workspace's name above the list showed for a team and vanished under Personal,
		// so each switch moved the list 44 px and the row under the pointer that had just clicked became
		// the other one, lit by its hover while Current sat elsewhere (CUR-3462). The list stays where it was.
		const listTop = async () => (await row('Personal workspace').boundingBox())!.y;
		const before = await listTop();

		await row(name).click();
		await expect(isCurrent(name)).toBeVisible({ timeout: 15_000 });
		await expect(accountStatus).toHaveText(name, { timeout: 15_000 });
		expect(await listTop(), 'switching to a workspace moved the list under the pointer').toBe(
			before
		);

		// Current stays on the team until the switch and the shell reload land, and the
		// Personal row said nothing meanwhile, so the pointer's hover fill on it read as a second
		// selection beside the team's Current (a graded recording caught it) (CUR-3462). Hold the switch.
		let releaseSwitch!: () => void;
		const switchHeld = new Promise<void>((resolve) => (releaseSwitch = resolve));
		const setActive = '**/chat/api/auth/organization/set-active*';
		await page.route(setActive, async (route) => {
			await switchHeld;
			await route.continue();
		});
		const switchAsked = page.waitForRequest((r) =>
			r.url().includes('/chat/api/auth/organization/set-active')
		);
		await row('Personal workspace').click();
		await switchAsked;
		await expect(
			row('Personal workspace').getByText('Switching…'),
			'the Personal row gave no sign it heard the click while Current still sat on the team'
		).toBeVisible();
		const switchAnswered = page.waitForResponse((r) =>
			r.url().includes('/chat/api/auth/organization/set-active')
		);
		releaseSwitch();
		expect((await switchAnswered).status(), 'the held switch to Personal failed').toBe(200);
		await page.unroute(setActive);
		await expect(
			isCurrent('Personal workspace'),
			'choosing Personal did not make it current'
		).toBeVisible({ timeout: 15_000 });
		await expect(isCurrent(name)).toHaveCount(0);
		// Read once, with no retry: Current moved to Personal while the account row still named the
		// team for about a second (a graded recording caught it), and both move in one step now.
		expect(
			(await accountStatus.textContent())?.trim(),
			'Personal was marked Current while the account row still named the team'
		).toBe('Personal workspace');
		expect(await listTop(), 'switching back to Personal moved the list under the pointer').toBe(
			before
		);
		await expectPersonalPanel(page, 'after switching back to Personal');
		await page.reload({ waitUntil: 'commit' });
		await expect(
			accountStatus,
			'after a reload the switch back to Personal was forgotten'
		).toHaveText('Personal workspace', { timeout: 30_000 });
	}
);

// Switching workspace took a trip to Settings → Workspace (CUR-3097). The account menu's Workspace row
// now opens a flyout listing Personal and each workspace, and one click switches.
test(
	'a person switches workspace from the account menu, and the switch survives a reload',
	{ tag: ['@preview-only', '@A8', '@CUR-3407'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		// The scene: a member of one workspace who is in Personal, the state a fresh sign-in leaves.
		const name = `E2E Menu ${Date.now()}`;
		const post = async (path: string, data: object) => {
			const res = await page.request.post(`/chat/api/auth/organization/${path}`, {
				data,
				headers: { origin: new URL(baseURL!).origin }
			});
			expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
		};
		await post('create', { name, slug: name.toLowerCase().replace(/\W+/g, '-') });
		await post('set-active', { organizationId: null });
		await page.reload({ waitUntil: 'commit' });

		const accountStatus = accountButton(page).locator('[data-account-status]');
		await expect(accountStatus).toHaveText('Personal workspace', { timeout: 30_000 });
		const option = (flyout: Locator, label: string) =>
			flyout.getByRole('menuitemradio', { name: label, exact: true });

		let flyout = await workspaceFlyout(page, { timeout: 30_000 });
		await expect(
			option(flyout, 'Personal workspace'),
			'the flyout does not mark Personal as current'
		).toHaveAttribute('aria-checked', 'true');
		await expect(option(flyout, name)).toHaveAttribute('aria-checked', 'false');

		// A switch replaces the chat list behind the menu, so the menu gets out of the way once
		// it lands, unlike Mode and Theme, where the person previews and may pick again (CUR-3174).
		const settingsItem = page.getByRole('menuitem', { name: 'Settings', exact: true });
		await option(flyout, name).click();
		await expect(accountStatus, 'the account row still names the old workspace').toHaveText(name, {
			timeout: 15_000
		});
		await expect(flyout, 'the Workspace flyout stayed open after the switch').toBeHidden({
			timeout: 5_000
		});
		await expect(
			settingsItem,
			'the account menu stayed open over the chat list it just changed'
		).toBeHidden();
		expect(page.url(), 'switching from the menu navigated away').not.toMatch(/\/settings\//);

		await page.reload({ waitUntil: 'commit' });
		await expect(accountStatus, 'after a reload the menu switch was forgotten').toHaveText(name, {
			timeout: 30_000
		});

		flyout = await workspaceFlyout(page, { timeout: 30_000 });
		await expect(option(flyout, name)).toHaveAttribute('aria-checked', 'true');
		await option(flyout, 'Personal workspace').click();
		await expect(accountStatus, 'choosing Personal from the menu did not switch back').toHaveText(
			'Personal workspace',
			{ timeout: 15_000 }
		);
		await expect(settingsItem, 'the account menu stayed open after switching back').toBeHidden({
			timeout: 5_000
		});

		// A switch that fails keeps the menu open, with the reason, so the person can see it and retry.
		// The failure is a dropped request (CUR-3206): a refusal naming membership, staged on the
		// workspace this account owns, read in the recording as the product doubting its own data.
		await page.route('**/chat/api/auth/organization/set-active', (route) => route.abort('failed'));
		flyout = await workspaceFlyout(page, { timeout: 30_000 });
		await option(flyout, name).click();
		await expect(
			flyout.getByRole('alert'),
			'a failed switch did not say why in the flyout'
		).toHaveText("Couldn't switch workspace.", { timeout: 15_000 });
		await expect(settingsItem, 'a failed switch closed the menu and hid its error').toBeVisible();
		await expect(accountStatus, 'a failed switch still changed the account row').toHaveText(
			'Personal workspace'
		);
		// The check stays with the workspace the person is in, not the one that refused (CUR-3407).
		await expect(
			option(flyout, name),
			'a failed switch left the check on the workspace it never reached'
		).toHaveAttribute('aria-checked', 'false');
		await expect(option(flyout, 'Personal workspace')).toHaveAttribute('aria-checked', 'true');
		await page.unroute('**/chat/api/auth/organization/set-active');
		await page.reload({ waitUntil: 'commit' });
		await expect(
			accountStatus,
			'after a reload the switch back to Personal was forgotten'
		).toHaveText('Personal workspace', { timeout: 30_000 });

		// The flyout's last item still reaches the full page.
		await openWorkspaceSettings(page, { timeout: 30_000 });
		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
	}
);

// While a menu switch ran, every row went disabled and grey with nothing saying why, so the
// menu read as frozen (CUR-4237). The clicked row now says "Switching…" and the others keep their contrast.
test(
	'a switch from the account menu labels the clicked row Switching… and leaves the other rows enabled (CUR-4237)',
	{ tag: ['@preview-only', '@A8', '@CUR-4237'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const name = `E2E Busy ${Date.now()}`;
		const res = await page.request.post('/chat/api/auth/organization/create', {
			data: { name, slug: name.toLowerCase().replace(/\W+/g, '-') },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(res.status(), `create answered ${res.status()}`).toBe(200);
		await page.request.post('/chat/api/auth/organization/set-active', {
			data: { organizationId: null },
			headers: { origin: new URL(baseURL!).origin }
		});
		await page.reload({ waitUntil: 'commit' });

		// Hold the switch open so the busy state can be read, then let it through.
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		await page.route('**/chat/api/auth/organization/set-active', async (route) => {
			await held;
			await route.continue();
		});
		const flyout = await workspaceFlyout(page, { timeout: 30_000 });
		const row = (label: RegExp) => flyout.getByRole('menuitemradio', { name: label });
		await row(new RegExp(`^${name}`)).click();
		await expect(
			row(new RegExp(`^${name}`)),
			'the clicked row does not say it is switching'
		).toContainText('Switching…', { timeout: 5_000 });
		await expect(
			row(/^Personal workspace/),
			'the other rows went disabled while the switch ran'
		).not.toHaveAttribute('aria-disabled', 'true');
		await expect(row(/^Personal workspace/)).not.toContainText('Switching…');
		release();
		await expect(
			accountButton(page).locator('[data-account-status]'),
			'the held switch never landed'
		).toHaveText(name, { timeout: 15_000 });
	}
);

// Every workspace listed the same conversations, so switching changed the label and the
// usage count but never the history (CUR-3023). Chats are made and titled through the API, so no model turn
// runs; the switches go through the page a person uses.
test(
	"each workspace lists only its own conversations, and a deleted workspace's chats sit under Former: <name>, read-only, not in Personal",
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		const origin = { origin: new URL(baseURL!).origin };
		const auth = async (path: string, data: object) => {
			const res = await page.request.post(`/chat/api/auth/organization/${path}`, {
				data,
				headers: origin
			});
			expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
			return (await res.json()) as { id?: string };
		};
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const model = models[0]?.id ?? models[0]?.name;
		const chat = async (title: string) => {
			const created = await page.request.post('/chat/conversation', { data: { model } });
			expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
			const { conversationId } = (await created.json()) as { conversationId: string };
			const titled = await page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
				data: { title }
			});
			expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);
			return conversationId;
		};

		// The scene: one chat started in Personal, one started in a team workspace.
		const name = `E2E Scoped ${Date.now()}`;
		const team = await auth('create', { name, slug: name.toLowerCase().replace(/\W+/g, '-') });
		expect(team.id, 'creating the workspace returned no id').toBeTruthy();
		await auth('set-active', { organizationId: null });
		const personalChat = await chat('Grocery list for the week');
		await auth('set-active', { organizationId: team.id });
		const teamChat = await chat('Quarterly volunteer rota');

		const railLink = (id: string) => page.locator(`a[href$="/conversation/${id}"]:visible`);
		const list = page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Your workspaces', exact: true }) });
		const switchTo = async (label: string) => {
			await openWorkspaceSettings(page, { timeout: 30_000 });
			await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
			await expect(list.getByText('Each workspace keeps its own conversations.')).toBeVisible({
				timeout: 30_000
			});
			await list.getByRole('button', { name: label }).click();
			await expect(
				list.getByRole('button', { name: label }).getByText('Current', { exact: true })
			).toBeVisible({ timeout: 15_000 });
			await page.goto(chatEntry(), { waitUntil: 'load' });
		};

		await page.goto(chatEntry(), { waitUntil: 'load' });
		await expect(railLink(teamChat)).toHaveText('Quarterly volunteer rota', { timeout: 30_000 });
		await expect(
			railLink(personalChat),
			'the team workspace lists a chat started in Personal'
		).toHaveCount(0);

		await switchTo('Personal workspace');
		await expect(railLink(personalChat)).toHaveText('Grocery list for the week', {
			timeout: 30_000
		});
		await expect(railLink(teamChat), 'Personal lists a chat started in the team').toHaveCount(0);

		await switchTo(name);
		await expect(railLink(teamChat)).toBeVisible({ timeout: 30_000 });
		await expect(
			railLink(personalChat),
			'switching back to the team still lists the Personal chat'
		).toHaveCount(0);

		// Deleting the workspace detaches its conversations rather than deleting them (CUR-3040). They
		// sit together under "Former: <name>", read-only, instead of mixing into Personal unmarked.
		await auth('delete', { organizationId: team.id });
		await auth('set-active', { organizationId: null });
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await expect(railLink(personalChat)).toBeVisible({ timeout: 30_000 });
		await expect(
			railLink(teamChat),
			'a chat from a deleted workspace is mixed into Personal'
		).toHaveCount(0);

		await viewFormerWorkspace(page, name);
		await expect(railLink(teamChat)).toHaveText('Quarterly volunteer rota', { timeout: 30_000 });
		await expect(
			railLink(personalChat),
			'the former workspace lists a chat started in Personal'
		).toHaveCount(0);
		await railLink(teamChat).click();
		await expectReadOnlyFormerChat(page, name);

		// CUR-3040's www walk: after viewing the former workspace, the account row still said Personal
		// over its chats, and choosing Personal in the account menu changed nothing, reload included.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		const accountStatus = accountButton(page).locator('[data-account-status]');
		await expect(
			accountStatus,
			"the account row names Personal while the former workspace's chats are listed"
		).toHaveText(`Former: ${name}`, { timeout: 15_000 });
		const flyout = await workspaceFlyout(page, { timeout: 30_000 });
		const formerItem = flyout.getByRole('menuitemradio', { name: `Former: ${name}`, exact: true });
		await expect(formerItem, 'the account menu does not list the former workspace').toBeChecked();
		await flyout.getByRole('menuitemradio', { name: 'Personal workspace', exact: true }).click();
		await expect(accountStatus).toHaveText('Personal workspace', { timeout: 15_000 });
		for (const when of ['after choosing Personal in the account menu', 'after a reload']) {
			if (when === 'after a reload') await page.reload({ waitUntil: 'load' });
			await expect(railLink(personalChat)).toBeVisible({ timeout: 30_000 });
			await expect(
				railLink(teamChat),
				`Personal lists the former workspace's chat ${when}`
			).toHaveCount(0);
		}
	}
);

// The line saying why a person landed in Personal lived inside the workspace list, so a
// person who deleted their last workspace lost the list and the reason with it (CUR-3022).
test(
	'deleting your last workspace lands you in Personal and still says why',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		// The scene: a person whose only workspace is the current one.
		const name = `E2E Last ${Date.now()}`;
		const res = await page.request.post('/chat/api/auth/organization/create', {
			data: { name, slug: name.toLowerCase().replace(/\W+/g, '-') },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(res.status(), `create answered ${res.status()}: ${await res.text()}`).toBe(200);
		const { id } = (await res.json()) as { id: string };
		const active = await page.request.post('/chat/api/auth/organization/set-active', {
			data: { organizationId: id },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(active.status()).toBe(200);

		await page.goto('/chat/settings/workspace', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Workspace rules' })).toBeVisible({
			timeout: 30_000
		});
		await page.getByRole('button', { name: 'Delete workspace…' }).click();
		await page.getByPlaceholder(name, { exact: true }).fill(name);
		await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();

		await expect(
			page.getByRole('heading', { name: 'Your workspaces', exact: true }),
			'the workspace list is still showing with no workspace left'
		).toHaveCount(0, { timeout: 15_000 });
		await expect(
			page.getByRole('status').filter({ hasText: `${name} was deleted` }),
			'with no workspace left, nothing says why the person is in Personal'
		).toBeVisible({ timeout: 15_000 });
		await expect(accountButton(page).locator('[data-account-status]')).toHaveText(
			'Personal workspace',
			{ timeout: 15_000 }
		);
	}
);

// The settings group disables SSR, so a fresh open of this page (a reload, a typed URL)
// arrived as an empty shell and painted white until the client bundle loaded (CUR-1975). Read the raw server
// response rather than the page, as application-settings.spec.ts does for CUR-2009: a browser
// assertion passes either way once hydration catches up, so only the HTML can tell the two apart.
test(
	'Workspace settings arrive server-rendered, so a fresh open paints the page without waiting on the client bundle',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		// `page.request` carries this context's session and flag-override cookies.
		const response = await page.request.get('/chat/settings/workspace');
		expect(response.ok(), `GET /chat/settings/workspace answered ${response.status()}`).toBe(true);
		const html = await response.text();
		expect(
			html,
			'the server sent an empty shell: the page renders only after the client bundle loads'
		).toContain('Workspace — Settings — Alpha');
		expect(html, 'the signed-in HTML does not carry this person’s own session').toContain(email);
		// The HTML carries the visitor's session, so no shared cache may keep it.
		expect(response.headers()['cache-control'] ?? '').toMatch(
			/\bprivate\b.*\bno-store\b|\bno-store\b.*\bprivate\b/
		);

		// The checks above read HTML and leave the browser on the welcome dialog, so the
		// gallery's recording never showed the page this test is named after (CUR-2969). Open it on screen too.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto('/chat/settings/workspace');
		await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
			timeout: 30_000
		});
	}
);

// A8 step 4, the invitee's half (CUR-2731). Every test above invites an address and then cancels it,
// so no account had ever opened an invitation and joined. The admin's half goes through Better Auth's
// own routes, since the first test already walks it on screen. The invitee opens the link the email
// carries, accepts, and lands in the workspace as a Member beside the admin.
test(
	'an invited person opens the invitation link, accepts, and joins the workspace as a Member',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		const flags = { workspaces: true, 'workspace-org-creation': true };
		const origin = { origin: new URL(baseURL!).origin };
		await setFlagOverrides(context, baseURL!, flags);
		const adminEmail = freshTestEmail();
		await signInAsFreshUser(page, adminEmail);

		const name = `E2E Invite ${Date.now()}`;
		const created = await page.request.post('/chat/api/auth/organization/create', {
			data: { name, slug: `e2e-invite-${Date.now()}` },
			headers: origin
		});
		expect(created.status(), `creating the workspace answered ${created.status()}`).toBe(200);
		const { id: organizationId } = (await created.json()) as { id: string };

		const inviteeEmail = freshTestEmail();
		const invited = await page.request.post('/chat/api/auth/organization/invite-member', {
			data: { organizationId, email: inviteeEmail, role: 'member' },
			headers: origin
		});
		expect(invited.status(), `inviting ${inviteeEmail} answered ${invited.status()}`).toBe(200);
		const { id: invitationId } = (await invited.json()) as { id: string };

		// The invitee is someone else on their own device: drop the admin's session, keep the flags.
		await context.clearCookies();
		await setFlagOverrides(context, baseURL!, flags);
		await signInAsFreshUser(page, inviteeEmail);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(`/chat/workspace/accept/${invitationId}`);
		await expect(
			page.getByRole('heading', { name: `Join ${name}` }),
			'the invitation page never named the workspace the invitee was asked to join'
		).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(`${adminEmail} invited you to join`)).toBeVisible();
		await holdForRecording(page);

		// The button went back to an idle Accept while the settings page loaded, inviting a
		// second click (CUR-3281). Hold that load, so the gap between the accept and the arrival is visible.
		let releaseSettings!: () => void;
		const settingsHeld = new Promise<void>((resolve) => (releaseSettings = resolve));
		const settingsData = '**/chat/settings/workspace/__data.json*';
		await page.route(settingsData, async (route) => {
			await settingsHeld;
			await route.continue();
		});
		const accepted = page.waitForResponse((r) =>
			r.url().includes('/chat/api/auth/organization/accept-invitation')
		);
		// The page asks for the settings data only after it has taken the accept in, so once that
		// request is out, whatever the button shows is what the page decided.
		const settingsAsked = page.waitForRequest((r) =>
			r.url().includes('/chat/settings/workspace/__data.json')
		);
		await page.getByRole('button', { name: 'Accept', exact: true }).click();
		expect((await accepted).status(), 'accepting the invitation was refused').toBe(200);
		await settingsAsked;
		await expect(
			page.getByRole('button', { name: 'Joining…' }),
			'after the accept went through, the button stopped saying it was joining before the page moved on'
		).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
		// Unrouting while the held request is still pending makes Playwright let it go itself, so the
		// handler's own continue then throws and the settings load fails. Let it answer first.
		const settingsAnswered = page.waitForResponse((r) =>
			r.url().includes('/chat/settings/workspace/__data.json')
		);
		releaseSettings();
		expect((await settingsAnswered).status(), 'the held settings data failed to load').toBe(200);
		await page.unroute(settingsData);

		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
		const joined = page.getByRole('button', { name });
		await expect(
			joined,
			'after accepting, the workspace is not among the invitee’s workspaces, so the accept never joined it'
		).toBeVisible({ timeout: 30_000 });
		await joined.click();
		await expect(
			page.getByText(`${inviteeEmail} · Member`, { exact: true }),
			'after accepting, the invitee is not listed in the workspace as a Member'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByText(`${adminEmail} · Admin`, { exact: true }),
			'the invitee joined a workspace that does not list the admin who invited them'
		).toBeVisible();
		await holdForRecording(page);
	}
);

// An invitee already signed in saw nothing in Alpha, so accepting meant finding the email (CUR-4167).
// Two workspaces invite the same person; they accept one from the account menu without the link,
// and decline the other in Settings → Workspace, where it stays gone after a reload.
test(
	'CUR-4167: a signed-in invitee sees pending invites in the account menu, accepts one there and declines one in Settings',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		const flags = { workspaces: true, 'workspace-org-creation': true };
		const origin = { origin: new URL(baseURL!).origin };
		await setFlagOverrides(context, baseURL!, flags);
		const adminEmail = freshTestEmail();
		await signInAsFreshUser(page, adminEmail);

		const inviteeEmail = freshTestEmail();
		const invite = async (name: string) => {
			const created = await page.request.post('/chat/api/auth/organization/create', {
				data: { name, slug: `e2e-pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
				headers: origin
			});
			expect(created.status(), `creating ${name} answered ${created.status()}`).toBe(200);
			const { id: organizationId } = (await created.json()) as { id: string };
			const invited = await page.request.post('/chat/api/auth/organization/invite-member', {
				data: { organizationId, email: inviteeEmail, role: 'member' },
				headers: origin
			});
			expect(
				invited.status(),
				`inviting ${inviteeEmail} to ${name} answered ${invited.status()}`
			).toBe(200);
		};
		const joinName = `E2E Pending join ${Date.now()}`;
		const declineName = `E2E Pending decline ${Date.now()}`;
		await invite(joinName);
		await invite(declineName);

		await context.clearCookies();
		await setFlagOverrides(context, baseURL!, flags);
		await signInAsFreshUser(page, inviteeEmail);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await expect(
			accountButton(page),
			'the account row never said invitations were waiting, so a signed-in invitee has no sign of them'
		).toContainText('2 workspace invitations waiting', { timeout: 30_000 });
		const flyout = await workspaceFlyout(page, { timeout: 30_000 });
		const joinItem = flyout.getByRole('menuitem', { name: new RegExp(joinName) });
		await expect(
			joinItem,
			'the Workspace flyout does not list the pending invitation'
		).toBeVisible();
		await expect(joinItem).toContainText(`Invited by ${adminEmail}`);
		await holdForRecording(page);
		await joinItem.click();

		await expect(
			page.getByRole('heading', { name: `Join ${joinName}` }),
			'opening the invite from the menu did not reach the invitation page'
		).toBeVisible({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Accept', exact: true }).click();
		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
		await expect(
			page.getByRole('button', { name: joinName }),
			'after accepting from the menu, the workspace is not among the invitee’s workspaces'
		).toBeVisible({ timeout: 30_000 });

		const invitations = page.locator('[data-invitations-to-me]');
		await expect(invitations.getByText(declineName)).toBeVisible({ timeout: 30_000 });
		await expect(
			invitations.getByText(joinName),
			'the accepted invite is still listed as pending'
		).toHaveCount(0);
		await holdForRecording(page);
		const declined = page.waitForResponse((r) =>
			r.url().includes('/chat/api/auth/organization/reject-invitation')
		);
		await page.getByRole('button', { name: `Decline: ${declineName}` }).click();
		expect((await declined).status(), 'declining the invitation was refused').toBe(200);
		await expect(invitations, 'the declined invite is still listed').toHaveCount(0, {
			timeout: 15_000
		});

		await page.reload();
		await expect(page.getByRole('button', { name: joinName })).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-invitations-to-me]'),
			'after a reload the declined invite came back, so the decline was never saved'
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: declineName })).toHaveCount(0);
	}
);

// A8 step 3, "gives each one of two roles" (CUR-1685). The invitee joins through Better Auth's own
// routes in a second context, since the test above walks accepting on screen. The admin then makes
// them an admin and back from the member list, and each change is read again after a reload, so a
// role the page only showed locally fails here.
test(
	'an admin makes a member an admin and back from the member list, and the role survives a reload',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const flags = { workspaces: true, 'workspace-org-creation': true };
		const origin = { origin: new URL(baseURL!).origin };
		await setFlagOverrides(context, baseURL!, flags);
		await signInAsFreshUser(page, freshTestEmail());

		const name = `E2E Roles ${Date.now()}`;
		const created = await page.request.post('/chat/api/auth/organization/create', {
			data: { name, slug: `e2e-roles-${Date.now()}` },
			headers: origin
		});
		expect(created.status(), `creating the workspace answered ${created.status()}`).toBe(200);
		const { id: organizationId } = (await created.json()) as { id: string };

		const inviteeEmail = freshTestEmail();
		const invited = await page.request.post('/chat/api/auth/organization/invite-member', {
			data: { organizationId, email: inviteeEmail, role: 'member' },
			headers: origin
		});
		expect(invited.status(), `inviting ${inviteeEmail} answered ${invited.status()}`).toBe(200);
		const { id: invitationId } = (await invited.json()) as { id: string };

		const inviteeContext = await browser.newContext({ baseURL });
		try {
			await setFlagOverrides(inviteeContext, baseURL!, flags);
			const inviteePage = await inviteeContext.newPage();
			await signInAsFreshUser(inviteePage, inviteeEmail);
			const accepted = await inviteePage.request.post(
				'/chat/api/auth/organization/accept-invitation',
				{ data: { invitationId }, headers: origin }
			);
			expect(accepted.status(), `accepting the invitation answered ${accepted.status()}`).toBe(200);
		} finally {
			await inviteeContext.close();
		}

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const openWorkspace = async () => {
			await page.goto('/chat/settings/workspace');
			const row = page.getByRole('button', { name });
			await expect(row, 'the workspace is not listed for its admin').toBeVisible({
				timeout: 30_000
			});
			await row.click();
		};
		const inviteeRole = (role: 'Admin' | 'Member') =>
			page.getByText(`${inviteeEmail} · ${role}`, { exact: true });
		// The rows came back in whatever order the server gave, so a role change could move
		// the member above the admin, and the grader read the swap as the role reverting (CUR-2768) or
		// the member vanishing (CUR-3171) (CUR-2906). Rows keep their join order: the admin who made it, first.
		const adminStaysFirst = (when: string) =>
			expect(
				page.getByTestId('workspace-member').first(),
				`the member list reordered ${when}`
			).toContainText('(you)');

		await journeyStep(page, 'A8', 9, async () => {
			await openWorkspace();
			await expect(
				inviteeRole('Member'),
				'the invitee did not join as a Member, so there is no role to change'
			).toBeVisible({ timeout: 30_000 });
			await holdForRecording(page);

			await page.getByRole('button', { name: `Make admin: ${inviteeEmail}` }).click();
			await expect(
				inviteeRole('Admin'),
				'after "Make admin" the member list still does not show the invitee as Admin'
			).toBeVisible({ timeout: 15_000 });
			await adminStaysFirst('after "Make admin"');
			await holdForRecording(page);
			await openWorkspace();
			await expect(
				inviteeRole('Admin'),
				'after a reload the invitee is no longer Admin, so the promotion was never saved'
			).toBeVisible({ timeout: 30_000 });
			await adminStaysFirst('after a reload following "Make admin"');

			await page.getByRole('button', { name: `Make member: ${inviteeEmail}` }).click();
			await expect(
				inviteeRole('Member'),
				'after "Make member" the member list still shows the invitee as Admin'
			).toBeVisible({ timeout: 15_000 });
			await openWorkspace();
			await expect(
				inviteeRole('Member'),
				'after a reload the invitee is Admin again, so the demotion was never saved'
			).toBeVisible({ timeout: 30_000 });
			await adminStaysFirst('after a reload following "Make member"');
			await holdForRecording(page);
		});
	}
);

// Production's shape is `workspaces` on and `workspace-org-creation` off, and every test
// above forces the second one on, so until these two nothing drove the screen production would serve (CUR-2174).
// The override turns org creation off on a preview where PostHog has it on. CUR-957's tests 1-3.
const PRODUCTION_SHAPE = {
	workspaces: true,
	'workspace-org-creation': false
};

test(
	'with org creation off, a signed-in person opens their own workspace from the account menu and nothing offers to create one or invite anyone',
	{ tag: ['@preview-only', '@A9'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, PRODUCTION_SHAPE);
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await openWorkspaceSettings(page, { timeout: 30_000 });
		await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });

		// Same 30s as the create heading above: the page waits on getSession before it settles.
		const yours = page.getByRole('heading', { name: 'Your workspace', exact: true });
		await expect(yours, 'the personal workspace never appeared').toBeVisible({ timeout: 30_000 });
		await expect(
			yours.locator('..'),
			'the personal workspace does not name the person it belongs to'
		).toContainText(email);
		await holdForRecording(page);

		for (const [what, offer] of [
			['a "New workspace" button', page.getByRole('button', { name: 'New workspace' })],
			[
				'a create-workspace heading',
				page.getByRole('heading', { name: /create (a|another) workspace/i })
			],
			['a workspace name field', page.getByPlaceholder("Your organisation or group's name")],
			['an invite heading', page.getByRole('heading', { name: 'Invite by email' })],
			['an invite address field', page.getByPlaceholder('name@example.org')]
		] as const) {
			await expect(offer, `with org creation off the page still shows ${what}`).toHaveCount(0);
		}
	}
);

// CUR-957's test 4: the screen hiding the controls proves nothing if the routes behind them still
// answer. The same calls are then repeated with org creation on, so a refusal here is the gate and
// not a wrong path that would be refused either way. The invitation page is checked by what a person
// sees here; the test below checks its status.
test(
	'with org creation off, the organization routes answer 404 and the invitation page shows Not found, and both reach the feature once it is on',
	{ tag: ['@preview-only', '@A9'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, PRODUCTION_SHAPE);
		await signInAsFreshUser(page, freshTestEmail());

		const list = async () => (await page.request.get('/chat/api/auth/organization/list')).status();
		const notFound = page.getByRole('heading', { name: 'Not found', exact: true });

		expect(await list(), 'listing organizations answered with org creation off').toBe(404);
		const create = await page.request.post('/chat/api/auth/organization/create', {
			data: { name: 'Should not exist', slug: `should-not-exist-${Date.now()}` },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(create.status(), 'creating an organization answered with org creation off').toBe(404);
		await page.goto('/chat/workspace/accept/not-a-real-invitation');
		await expect(notFound, 'the invitation page rendered with org creation off').toBeVisible({
			timeout: 15_000
		});

		// Control. Only the reads are repeated, so the control creates nothing.
		await setFlagOverrides(context, baseURL!, {
			...PRODUCTION_SHAPE,
			'workspace-org-creation': true
		});
		expect(
			await list(),
			'with org creation on, the list route is still refused, so the 404 above proves nothing'
		).toBe(200);
		await page.goto('/chat/workspace/accept/not-a-real-invitation');
		await page.waitForLoadState('domcontentloaded');
		await expect(
			notFound,
			'with org creation on, the invitation page still says Not found, so the check above proves nothing'
		).toHaveCount(0);
	}
);

// A /chat page streams its response, because the chat layout returns the sidebar's conversations as
// a promise, and SvelteKit 2.x built a streamed response without the page's status, so a page that
// threw `error(404)` rendered Not found and answered 200. `patches/@sveltejs__kit@2.70.3.patch` passes
// the status through, as SvelteKit 3 does (CUR-2605); this test goes red if a SvelteKit bump drops it.
test(
	'with org creation off, the invitation page answers HTTP 404, not only a page that says Not found',
	{ tag: ['@preview-only', '@A9'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, PRODUCTION_SHAPE);
		await signInAsFreshUser(page, freshTestEmail());

		const response = await page.goto('/chat/workspace/accept/not-a-real-invitation');
		await expect(
			page.getByRole('heading', { name: 'Not found', exact: true }),
			'the invitation page did not render Not found, so its status says nothing about the gate'
		).toBeVisible({ timeout: 15_000 });
		expect(response?.status(), 'the gated invitation page says Not found but answers').toBe(404);
	}
);

// A8 step 16 (CUR-3024). Better Auth keeps the active workspace on the session, and logging out
// deletes the session, so every sign-in used to land in Personal and someone who works in a team
// workspace had to switch back each morning. The second sign-in walks the real email-code flow:
// signInAsFreshUser mints its session through the test-only auth instance, which would never run
// the app's own session hooks.
test(
	'signing in again lands in the workspace the person last chose, and in Personal once it is deleted',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');
		await setFlagOverrides(context, baseURL!, {
			workspaces: true,
			'workspace-org-creation': true
		});
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const accountStatus = accountButton(page).locator('[data-account-status]');
		const openSettingsPage = async () => {
			await openWorkspaceSettings(page, { timeout: 30_000 });
			await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
		};
		const logOutAndBackIn = async () => {
			// Log out ends in a hard reload (NavMenu.svelte's handleLogout), and a goto fired while it is
			// in flight is aborted (net::ERR_ABORTED), so wait for it to land first.
			const reloaded = page.waitForEvent('load', { timeout: 30_000 });
			await (await accountMenuItem(page, 'Log out', { timeout: 20_000 })).click();
			await reloaded;
			await expect(accountButton(page)).toHaveAccessibleName('Account — guest', {
				timeout: 15_000
			});
			await signInWithEmailOtp(page, databaseUrl, email);
		};

		const stamp = Date.now();
		const team = `E2E Team ${stamp}`;
		const other = `E2E Other ${stamp}`;
		const row = (name: string) => page.getByRole('button', { name });
		const nameInput = page.getByPlaceholder("Your organisation or group's name");

		// Two workspaces, then a click back to the first, so the one resumed is the one chosen last
		// rather than the one made last.
		await openSettingsPage();
		await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
			timeout: 30_000
		});
		await nameInput.fill(team);
		await page.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(row(team).getByText('Current', { exact: true })).toBeVisible({ timeout: 15_000 });
		await page.getByRole('button', { name: 'New workspace' }).click();
		await nameInput.fill(other);
		await page.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(row(other).getByText('Current', { exact: true })).toBeVisible({ timeout: 15_000 });
		await row(team).click();
		await expect(accountStatus).toHaveText(team, { timeout: 15_000 });

		await journeyStep(page, 'A8', 16, async () => {
			await logOutAndBackIn();
			await expect(
				accountStatus,
				'after logging out and back in, the chat is not in the workspace the person last chose'
			).toHaveText(team, { timeout: 15_000 });
			await holdForRecording(page);
		});

		// Deleting it records Personal as the choice, so the next sign-in starts there and never in the
		// other team workspace.
		await openSettingsPage();
		await expect(row(team).getByText('Current', { exact: true })).toBeVisible({ timeout: 15_000 });
		await page.getByRole('button', { name: 'Delete workspace…' }).click();
		await page.getByPlaceholder(team, { exact: true }).fill(team);
		await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
		await expect(row(team)).toHaveCount(0, { timeout: 15_000 });
		await expect(accountStatus).toHaveText('Personal workspace', { timeout: 15_000 });
		await logOutAndBackIn();
		await expect(
			accountStatus,
			'after the chosen workspace was deleted, a new sign-in did not start in Personal'
		).toHaveText('Personal workspace', { timeout: 15_000 });
	}
);
