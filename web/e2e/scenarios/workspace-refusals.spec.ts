// e2e-product: @chat
// e2e-area: @storage
import { test, expect } from './helpers/test';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { chatEntry } from './helpers/chatEntry';
import { expectReadOnlyFormerChat, viewFormerWorkspace } from './helpers/formerWorkspace';
import { accountButton, workspaceFlyout } from './helpers/accountMenu';
import { startChattingPastWelcome } from './helpers/welcome';
import type { BrowserContext, Page } from '@playwright/test';

// A8 rows 10-14 (CUR-2835): what a workspace admin or invitee sees when the product says no, each
// graded on its own row. Like the rest of A8, @preview-only: the surface is reached by forcing both workspace flags through the override
// cookie, which production does not wire.
//
// The journey reporter files one video per test, from the test's own `page` (journeyArtifacts.ts
// `onTestEnd`), and a context a test opens with `browser.newContext()` is not filmed. So each test
// below walks its step on `page`, as the person the row is about, and keeps every other account in
// a side context. Rows 10, 12 and 13 ran wholly in side contexts, passed, and reached the grader with
// no footage (CUR-2868, CUR-2869, CUR-2870).

const FLAGS = { workspaces: true, 'workspace-org-creation': true };

// Library wording that must never reach a visitor: the app says workspace and admin.
const LIBRARY_WORDS = /organization|owner/i;
const RAW_NOT_FOUND = /Invitation not found!/;

// The page's own slug rule (+page.svelte `slugify`), so a slug made here collides with the one the
// page derives from the same name.
const slugify = (name: string) =>
	name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 50) || 'workspace';

async function api(page: Page, baseURL: string, path: string, data: object) {
	const res = await page.request.post(`/chat/api/auth/organization/${path}`, {
		data,
		headers: { origin: new URL(baseURL).origin }
	});
	expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
	return res.json();
}

/** Signs a new account in. Pass the test's own `page` for the person the step films; without one,
 *  a new page in `context`, for an account that only sets the scene. */
async function freshAccount(
	context: BrowserContext,
	baseURL: string,
	email = freshTestEmail(),
	onPage?: Page
) {
	await setFlagOverrides(context, baseURL, FLAGS);
	const page = onPage ?? (await context.newPage());
	await signInAsFreshUser(page, email);
	await dismissWelcome(page);
	return { page, email };
}

const welcomeHandled = new WeakSet<Page>();
async function dismissWelcome(page: Page) {
	if (welcomeHandled.has(page)) return;
	welcomeHandled.add(page);
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
}

const currentBadge = (page: Page, name: string) =>
	page.getByRole('button', { name }).getByText('Current', { exact: true });

// Scoped to the list: the sidebar's account button also reads "Personal workspace".
const workspaceList = (page: Page) =>
	page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Your workspaces', exact: true }) });
const personalBadge = (page: Page) =>
	workspaceList(page)
		.getByRole('button', { name: 'Personal workspace' })
		.getByText('Current', { exact: true });

// Losing your current workspace lands you in Personal with a line saying why (CUR-3022). Another team
// workspace you belong to is listed but never picked for you.
async function expectLandedInPersonal(page: Page, otherWorkspace: string) {
	await expect(
		personalBadge(page),
		'after losing the current workspace, Personal is not the current one'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		currentBadge(page, otherWorkspace),
		'losing the current workspace moved the person into another team workspace'
	).toHaveCount(0);
	await expect(workspaceList(page).getByRole('status')).toContainText('personal workspace');
}

test(
	'a workspace named the same as another account’s is still created and marked Current',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const name = `E2E Same Name ${Date.now()}`;
		const first = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(first, baseURL!);
			await api(a.page, baseURL!, 'create', { name, slug: slugify(name) });

			const b = await freshAccount(context, baseURL!, undefined, page);
			await journeyStep(b.page, 'A8', 10, async () => {
				await b.page.goto('/chat/settings/workspace');
				await expect(b.page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
					timeout: 30_000
				});
				await b.page.getByPlaceholder("Your organisation or group's name").fill(name);
				await b.page.getByRole('button', { name: 'Create', exact: true }).click();
				await expect(
					currentBadge(b.page, name),
					'a name another account already used was refused, so this person has no workspace'
				).toBeVisible({ timeout: 15_000 });
				await expect(b.page.getByText(LIBRARY_WORDS)).toHaveCount(0);
				await holdForRecording(b.page);
			});
		} finally {
			await first.close();
		}
	}
);

test(
	'a new account’s invite past its daily limit of 5 is refused on the page, naming the limit, and is never listed as pending (CUR-4168)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, FLAGS);
		await signInAsFreshUser(page, freshTestEmail());
		const name = `E2E Invite Cap ${Date.now()}`;
		const { id: organizationId } = await api(page, baseURL!, 'create', {
			name,
			slug: slugify(name)
		});
		// A fresh account's daily cap is 5 (workspaceInviteRate.ts, CUR-4168), so two throwaway accounts
		// cannot spend the site-wide ceiling. Spend it through the API; the visitor's own attempt is the
		// 6th, on screen.
		for (let i = 0; i < 5; i++) {
			await api(page, baseURL!, 'invite-member', {
				organizationId,
				email: freshTestEmail(),
				role: 'member'
			});
		}
		const overCap = freshTestEmail();
		await journeyStep(page, 'A8', 11, async () => {
			await page.goto('/chat/settings/workspace');
			await page.getByRole('button', { name }).click();
			await page.getByPlaceholder('name@example.org').fill(overCap);
			await page.getByRole('button', { name: 'Invite', exact: true }).click();
			await expect(
				page.getByText(/\b5 invitations a day/i),
				'a new account’s 6th invite in a day was not refused with the limit named'
			).toBeVisible({ timeout: 15_000 });
			// Visible in the DOM is not the same as on screen (CUR-3207); the graded recording had it below the fold.
			await expect(
				page.getByRole('alert').filter({ hasText: /\b5 invitations a day/i }),
				'the invite-limit refusal is off screen'
			).toBeInViewport({ ratio: 1 });
			await expect(
				page.getByText(overCap, { exact: true }),
				'an invite that was never sent is listed as pending'
			).toHaveCount(0);
			await holdForRecording(page);
		});
	}
);

// Inviting your own address (CUR-3053). Better Auth refuses it and creates nothing, but the page
// showed its raw "already a member of this organization" text, library words and all.
test(
	'inviting your own address is refused in the app’s words, wholly on screen, and the list of workspaces does not change (CUR-4060)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		const { email } = await freshAccount(context, baseURL!, undefined, page);
		const name = `E2E Self Invite ${Date.now()}`;
		await api(page, baseURL!, 'create', { name, slug: slugify(name) });
		await page.goto('/chat/settings/workspace');
		await page.getByRole('button', { name }).click();
		const before = await workspaceList(page).getByRole('button').count();
		await page.getByPlaceholder('name@example.org').fill(email);
		await page.getByRole('button', { name: 'Invite', exact: true }).click();
		await expect(
			page.getByText('That address is already in this workspace.'),
			'inviting your own address was not refused in plain words'
		).toBeVisible({ timeout: 15_000 });
		// The refusal has to be where the person is looking, not only somewhere on the page (CUR-3207).
		// And all of it (CUR-4060); a line half under the bottom edge passed a bare toBeInViewport().
		await expect(
			page.getByRole('alert').filter({ hasText: 'That address is already in this workspace.' }),
			'the self-invite refusal is off screen'
		).toBeInViewport({ ratio: 1 });
		await expect(page.getByText(LIBRARY_WORDS)).toHaveCount(0);
		await expect(
			workspaceList(page).getByRole('button'),
			'inviting your own address changed the list of workspaces'
		).toHaveCount(before);
		await holdForRecording(page);
	}
);

// The Current badge now waits for the workspace's detail, so the list and the panel below
// change together (CUR-3373). The switch is saved before that load starts, so a load that never answers (a dropped
// connection, not an error reply) must still move the badge and the account row, and say the detail
// could not load.
test(
	'a switch whose workspace detail fails to load still marks that workspace current, says so, and Try again loads it (CUR-4026)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await freshAccount(context, baseURL!, undefined, page);
		const stamp = Date.now();
		const first = `E2E Detail First ${stamp}`;
		const second = `E2E Detail Second ${stamp}`;
		await api(page, baseURL!, 'create', { name: first, slug: slugify(first) });
		await api(page, baseURL!, 'create', { name: second, slug: slugify(second) });
		await page.goto('/chat/settings/workspace');
		const row = (name: string) => workspaceList(page).getByRole('button', { name });
		const isCurrent = (name: string) => row(name).getByText('Current', { exact: true });
		await expect(isCurrent(second)).toBeVisible({ timeout: 30_000 });

		const detail = '**/chat/api/auth/organization/get-full-organization*';
		await page.route(detail, (route) => route.abort('failed'));
		await row(first).click();
		await expect(
			isCurrent(first),
			'the switch was saved but its detail failed to load, and the badge stayed on the old workspace'
		).toBeVisible({ timeout: 15_000 });
		await expect(isCurrent(second)).toHaveCount(0);
		await expect(
			accountButton(page).locator('[data-account-status]'),
			'the account row did not follow a switch whose detail failed to load'
		).toHaveText(first, { timeout: 15_000 });
		await expect(page.getByText("Couldn't load that workspace.")).toBeVisible();
		await page.unroute(detail);
		// The failed load offers a way forward, and taking it loads the workspace (CUR-4026).
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(
			page.getByText(/only admin, so you can't leave/i),
			'Try again after a failed workspace load did not bring the workspace back'
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Couldn't load that workspace.")).toHaveCount(0);
		await holdForRecording(page);
	}
);

// Logging out from this page signs out, then spends a moment on the app's own logout
// before reloading (CUR-3280). A request the page made in that gap came back 401 and printed Better Auth's bare
// "Unauthorized" under the workspace list. The session is ended here by dropping its cookies, and a
// click on the workspace makes the page ask again.
// The notice used to sit under a live workspace list and an enabled New workspace button,
// with no way to sign in (CUR-4108). Now it replaces the controls and links to sign-in, back to this page.
test(
	'a workspace page whose session has ended says so in plain words, never "Unauthorized", hides the controls and offers Sign in (CUR-4108)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await freshAccount(context, baseURL!, undefined, page);
		const name = `E2E Signed Out ${Date.now()}`;
		await api(page, baseURL!, 'create', { name, slug: slugify(name) });
		await page.goto('/chat/settings/workspace');
		const row = workspaceList(page).getByRole('button', { name });
		await expect(row).toBeVisible({ timeout: 30_000 });

		await context.clearCookies();
		await setFlagOverrides(context, baseURL!, FLAGS);
		await row.click();
		await expect(
			page.getByText(/You're signed out\. Sign in again/),
			'a request refused for want of a session did not tell the person they are signed out'
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('Unauthorized', { exact: true })).toHaveCount(0);
		await expect(
			workspaceList(page),
			'the workspace list stayed up under a session that has ended'
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'New workspace' })).toHaveCount(0);
		await expect(
			accountButton(page),
			'the sidebar account row still names the signed-in person beside the signed-out notice'
		).toHaveAccessibleName('Account — guest', { timeout: 15_000 });
		const signIn = page.getByRole('alert').getByRole('link', { name: 'Sign in', exact: true });
		await expect(signIn, 'the signed-out notice gave no way to sign in').toBeVisible();
		await holdForRecording(page);
		await signIn.click();
		await expect(page).toHaveURL(/\/chat\/login\?next=%2Fchat%2Fsettings%2Fworkspace/);
	}
);

test(
	'a cancelled invitation’s link says so and points back to chat; the wrong account is told to sign in as the invited address',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const admin = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(admin, baseURL!);
			const name = `E2E Dead Link ${Date.now()}`;
			const { id: organizationId } = await api(a.page, baseURL!, 'create', {
				name,
				slug: slugify(name)
			});
			const inviteeEmail = freshTestEmail();
			const live = await api(a.page, baseURL!, 'invite-member', {
				organizationId,
				email: inviteeEmail,
				role: 'member'
			});
			const cancelledEmail = freshTestEmail();
			const cancelled = await api(a.page, baseURL!, 'invite-member', {
				organizationId,
				email: cancelledEmail,
				role: 'member'
			});
			await api(a.page, baseURL!, 'cancel-invitation', { invitationId: cancelled.id });

			const i = await freshAccount(context, baseURL!, cancelledEmail, page);
			await journeyStep(i.page, 'A8', 12, async () => {
				await i.page.goto(`/chat/workspace/accept/${cancelled.id}`);
				await expect(
					i.page.getByText(/cancelled or has expired/i),
					'a cancelled invitation’s link does not say what happened to it'
				).toBeVisible({ timeout: 30_000 });
				await expect(i.page.getByText(/ask .* for a new one/i)).toBeVisible();
				await expect(i.page.getByText(RAW_NOT_FOUND)).toHaveCount(0);
				await expect(i.page.getByRole('link', { name: /back to chat/i })).toBeVisible();
				await holdForRecording(i.page);

				// The second half is a different person on the same filmed page: sign the invitee out
				// and a stranger in, and say so on screen, since the grader cannot see a cookie change.
				await context.clearCookies();
				const s = await freshAccount(context, baseURL!, undefined, page);
				await captionForRecording(
					s.page,
					'signed in as a different account, opening an invitation sent to someone else'
				);
				await s.page.goto(`/chat/workspace/accept/${live.id}`);
				await expect(
					s.page.getByText(/sent to a different email address/i),
					'a signed-in stranger opening someone else’s invitation is not told why it fails'
				).toBeVisible({ timeout: 30_000 });
				await expect(s.page.getByRole('button', { name: /sign out/i })).toBeVisible();
				// The page must not reveal whose invitation it is to the wrong account.
				await expect(s.page.getByText(inviteeEmail)).toHaveCount(0);
				await holdForRecording(s.page);
			});
		} finally {
			await admin.close();
		}
	}
);

test(
	'a member whose current workspace is deleted by its admin lands in Personal, told why, not in another team workspace',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const admin = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(admin, baseURL!);
			const shared = `E2E Shared ${Date.now()}`;
			const { id: sharedId } = await api(a.page, baseURL!, 'create', {
				name: shared,
				slug: slugify(shared)
			});
			const memberEmail = freshTestEmail();
			const inv = await api(a.page, baseURL!, 'invite-member', {
				organizationId: sharedId,
				email: memberEmail,
				role: 'member'
			});

			const m = await freshAccount(context, baseURL!, memberEmail, page);
			await api(m.page, baseURL!, 'accept-invitation', { invitationId: inv.id });
			const own = `E2E Own ${Date.now()}`;
			await api(m.page, baseURL!, 'create', { name: own, slug: slugify(own) });
			await api(m.page, baseURL!, 'set-active', { organizationId: sharedId });

			await api(a.page, baseURL!, 'delete', { organizationId: sharedId });

			await journeyStep(m.page, 'A8', 13, async () => {
				await m.page.goto('/chat/settings/workspace');
				await expect(m.page.getByRole('button', { name: own })).toBeVisible({ timeout: 30_000 });
				await expect(m.page.getByRole('button', { name: shared })).toHaveCount(0);
				await expectLandedInPersonal(m.page, own);
				await m.page.reload({ waitUntil: 'commit' });
				await expect(
					personalBadge(m.page),
					'Personal did not survive a reload, so the switch never reached the session'
				).toBeVisible({ timeout: 30_000 });
				await expect(currentBadge(m.page, own)).toHaveCount(0);
				// The reason has to survive the reload too, or Personal just looks like a reset (CUR-3089).
				await expect(
					workspaceList(m.page).getByRole('status'),
					'after a reload nothing says why the person is in Personal'
				).toContainText('personal workspace', { timeout: 15_000 });
				await holdForRecording(m.page);
			});
		} finally {
			await admin.close();
		}
	}
);

test(
	'a member removed from their current workspace lands in Personal, told why, not in another team workspace',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const admin = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(admin, baseURL!);
			const shared = `E2E Shared ${Date.now()}`;
			const { id: sharedId } = await api(a.page, baseURL!, 'create', {
				name: shared,
				slug: slugify(shared)
			});
			const memberEmail = freshTestEmail();
			const inv = await api(a.page, baseURL!, 'invite-member', {
				organizationId: sharedId,
				email: memberEmail,
				role: 'member'
			});

			const m = await freshAccount(context, baseURL!, memberEmail, page);
			await api(m.page, baseURL!, 'accept-invitation', { invitationId: inv.id });
			const own = `E2E Own ${Date.now()}`;
			await api(m.page, baseURL!, 'create', { name: own, slug: slugify(own) });
			await api(m.page, baseURL!, 'set-active', { organizationId: sharedId });

			await api(a.page, baseURL!, 'remove-member', {
				organizationId: sharedId,
				memberIdOrEmail: memberEmail
			});

			await m.page.goto('/chat/settings/workspace');
			await expect(m.page.getByRole('button', { name: own })).toBeVisible({ timeout: 30_000 });
			await expect(m.page.getByRole('button', { name: shared })).toHaveCount(0);
			await expectLandedInPersonal(m.page, own);
		} finally {
			await admin.close();
		}
	}
);

// A removed member's chats from that team used to fold into Personal with nothing saying
// where they came from (CUR-3040). Chats are made and titled through the API, so no model turn runs.
test(
	"a removed member's chats from that team sit under Former: <team>, read-only, not in Personal",
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		test.setTimeout(180_000);
		const admin = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(admin, baseURL!);
			const shared = `E2E Former ${Date.now()}`;
			const { id: sharedId } = await api(a.page, baseURL!, 'create', {
				name: shared,
				slug: slugify(shared)
			});
			const memberEmail = freshTestEmail();
			const inv = await api(a.page, baseURL!, 'invite-member', {
				organizationId: sharedId,
				email: memberEmail,
				role: 'member'
			});

			const m = await freshAccount(context, baseURL!, memberEmail, page);
			await api(m.page, baseURL!, 'accept-invitation', { invitationId: inv.id });
			const models = (await (await m.page.request.get('/chat/api/models')).json()) as {
				id?: string;
				name?: string;
			}[];
			const model = models[0]?.id ?? models[0]?.name;
			const chat = async (title: string) => {
				const created = await m.page.request.post('/chat/conversation', { data: { model } });
				expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
				const { conversationId } = (await created.json()) as { conversationId: string };
				const titled = await m.page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
					data: { title }
				});
				expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);
				return conversationId;
			};
			await api(m.page, baseURL!, 'set-active', { organizationId: null });
			const personalChat = await chat('Birthday present ideas');
			await api(m.page, baseURL!, 'set-active', { organizationId: sharedId });
			const teamChat = await chat('Food bank delivery routes');

			await api(a.page, baseURL!, 'remove-member', {
				organizationId: sharedId,
				memberIdOrEmail: memberEmail
			});

			const railLink = (id: string) => m.page.locator(`a[href$="/conversation/${id}"]:visible`);
			await m.page.goto(chatEntry(), { waitUntil: 'load' });
			await expect(railLink(personalChat)).toBeVisible({ timeout: 30_000 });
			await expect(
				railLink(teamChat),
				"a removed member's team chat is mixed into Personal"
			).toHaveCount(0);

			await viewFormerWorkspace(m.page, shared);
			await expect(railLink(teamChat)).toHaveText('Food bank delivery routes', {
				timeout: 30_000
			});
			await expect(railLink(personalChat)).toHaveCount(0);
			await railLink(teamChat).click();
			await expectReadOnlyFormerChat(m.page, shared);
		} finally {
			await admin.close();
		}
	}
);

// Remove is offered on other members' rows only (CUR-3385). Taking yourself out is Leave, which
// refuses the only admin ('the only admin trying to leave…' below).
test(
	'the only admin finds no Remove on their own row, so nobody takes themselves out by accident',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, FLAGS);
		const email = freshTestEmail();
		await signInAsFreshUser(page, email);
		const name = `E2E Sole Admin ${Date.now()}`;
		await api(page, baseURL!, 'create', { name, slug: slugify(name) });

		await journeyStep(page, 'A8', 14, async () => {
			await page.goto('/chat/settings/workspace');
			const row = page.getByTestId('workspace-member').filter({ hasText: email });
			await expect(row).toContainText(`${email} · Admin`, { timeout: 30_000 });
			await expect(
				row.getByRole('button', { name: /^Remove/ }),
				'the admin is offered Remove on their own row'
			).toHaveCount(0);
			await expect(
				page.getByText(/only admin, so you can't leave/i),
				'the only admin is not told how Leave works for them'
			).toBeVisible();
			await holdForRecording(page);
		});
	}
);

// Remove took a member out on one click while Leave and Delete both asked first (CUR-3385).
test(
	'an admin removing a member is asked first, naming them; Cancel keeps them and confirming removes them',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const other = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(context, baseURL!, freshTestEmail(), page);
			const name = `E2E Remove ${Date.now()}`;
			const { id } = await api(a.page, baseURL!, 'create', { name, slug: slugify(name) });
			const memberEmail = freshTestEmail();
			const inv = await api(a.page, baseURL!, 'invite-member', {
				organizationId: id,
				email: memberEmail,
				role: 'member'
			});
			const m = await freshAccount(other, baseURL!, memberEmail);
			await api(m.page, baseURL!, 'accept-invitation', { invitationId: inv.id });

			await journeyStep(page, 'A8', 19, async () => {
				await page.goto('/chat/settings/workspace');
				const row = page.getByTestId('workspace-member').filter({ hasText: memberEmail });
				await expect(row).toContainText(`${memberEmail} · Member`, { timeout: 30_000 });
				const remove = row.getByRole('button', { name: /^Remove / });
				// The row's first line is the name the page shows for this person (name, else email).
				const shown = (await row.innerText()).split('\n')[0].trim();
				expect(shown, 'the member row shows nobody').not.toBe('');
				await expect(
					remove,
					'Remove does not name the member it would remove'
				).toHaveAccessibleName(`Remove ${shown}…`);
				await remove.click();
				const confirm = page.getByTestId('workspace-remove-confirm');
				await expect(confirm, 'Remove did not ask first').toBeVisible();
				await expect(confirm).toContainText(name);
				await captionForRecording(page, 'Remove asks first, naming the person and the workspace');
				await confirm.getByRole('button', { name: 'Cancel' }).click();
				await expect(confirm).toHaveCount(0);
				await expect(row, 'Cancel removed the member anyway').toContainText(memberEmail);

				await remove.click();
				await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
				await expect(row, 'confirming did not remove the member').toHaveCount(0, {
					timeout: 15_000
				});
				await page.reload();
				await expect(page.getByTestId('workspace-member').first()).toBeVisible({ timeout: 30_000 });
				await expect(
					page.getByTestId('workspace-member').filter({ hasText: memberEmail }),
					'the removed member came back after a reload'
				).toHaveCount(0);
				await holdForRecording(page);
			});
		} finally {
			await other.close();
		}
	}
);

// "request" and "open" have no join flow, so neither can be stored (CUR-3021). The admin is refused in
// workspace words, and the workspace still reads as invitation-only.
test(
	'a workspace cannot be set to a join method nobody can use, and still reads By invitation only',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, FLAGS);
		await signInAsFreshUser(page, freshTestEmail());
		await dismissWelcome(page);
		const origin = new URL(baseURL!).origin;
		const post = (path: string, data: object) =>
			page.request.post(`/chat/api/auth/organization/${path}`, { data, headers: { origin } });

		const refusedName = `E2E Open Join ${Date.now()}`;
		const refusedCreate = await post('create', {
			name: refusedName,
			slug: slugify(refusedName),
			joinMethod: 'open'
		});
		expect(refusedCreate.status(), 'a workspace was created as open to anyone').toBe(400);
		expect(await refusedCreate.text()).toMatch(/invitation only/);

		const name = `E2E Join Method ${Date.now()}`;
		const { id: organizationId } = await api(page, baseURL!, 'create', {
			name,
			slug: slugify(name)
		});
		for (const joinMethod of ['request', 'open']) {
			const res = await post('update', { organizationId, data: { joinMethod } });
			const body = await res.text();
			expect(res.status(), `an update to "${joinMethod}" was stored: ${body}`).toBe(400);
			expect(body).toMatch(/invitation only/);
			expect(body).not.toMatch(LIBRARY_WORDS);
		}

		await page.goto('/chat/settings/workspace');
		await page.getByRole('button', { name }).click();
		await expect(
			page.getByText('By invitation only', { exact: true }),
			'after the refused updates the workspace no longer reads invitation-only'
		).toBeVisible({ timeout: 15_000 });
	}
);

// Leaving a workspace and renaming one, from its own settings (CUR-3106).
test(
	'a member leaves a workspace they were invited to and lands in Personal, with it gone from the account menu',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, browser, baseURL }) => {
		const admin = await browser.newContext({ baseURL });
		try {
			const a = await freshAccount(admin, baseURL!);
			const shared = `E2E Leave ${Date.now()}`;
			const { id: sharedId } = await api(a.page, baseURL!, 'create', {
				name: shared,
				slug: slugify(shared)
			});
			const memberEmail = freshTestEmail();
			const inv = await api(a.page, baseURL!, 'invite-member', {
				organizationId: sharedId,
				email: memberEmail,
				role: 'member'
			});
			const m = await freshAccount(context, baseURL!, memberEmail, page);
			await api(m.page, baseURL!, 'accept-invitation', { invitationId: inv.id });
			await api(m.page, baseURL!, 'set-active', { organizationId: sharedId });

			await m.page.goto('/chat/settings/workspace');
			await expect(currentBadge(m.page, shared)).toBeVisible({ timeout: 30_000 });
			await m.page.getByRole('button', { name: 'Leave workspace…' }).click();
			await m.page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
			await expect(
				m.page.getByRole('button', { name: shared }),
				'the workspace just left is still listed'
			).toHaveCount(0, { timeout: 15_000 });
			await expect(
				m.page.getByRole('status').filter({ hasText: `You left ${shared}` }),
				'leaving gave no line saying where the person landed'
			).toBeVisible();

			await m.page.reload({ waitUntil: 'load' });
			await expect(accountButton(m.page).locator('[data-account-status]')).toHaveText(
				'Personal workspace',
				{ timeout: 30_000 }
			);
			const flyout = await workspaceFlyout(m.page, { timeout: 20_000 });
			await expect(
				flyout.getByRole('menuitemradio', { name: shared }),
				'the account menu still offers the workspace just left'
			).toHaveCount(0);
			await holdForRecording(m.page);
		} finally {
			await admin.close();
		}
	}
);

test(
	'the only admin is told up front, in workspace words, that they cannot leave, is offered no Leave button and no line saying they will leave, and stays in it (CUR-4020)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, FLAGS);
		await signInAsFreshUser(page, freshTestEmail());
		await dismissWelcome(page);
		const name = `E2E Sole Leaver ${Date.now()}`;
		await api(page, baseURL!, 'create', { name, slug: slugify(name) });

		await page.goto('/chat/settings/workspace');
		const refusal = page.getByText(/only admin, so you can't leave/i);
		await expect(refusal, 'the sole admin is not told why they cannot leave').toBeVisible({
			timeout: 30_000
		});
		await refusal.scrollIntoViewIfNeeded();
		await expect(refusal, 'the sole-admin Leave refusal is off screen').toBeInViewport({
			ratio: 1
		});
		// A Leave that answered "Leaving…" and then refused contradicted itself, so none is offered (CUR-4020).
		await expect(
			page.getByRole('button', { name: /^Leave workspace/ }),
			'the only admin is offered a Leave that the server will refuse'
		).toHaveCount(0);
		await expect(
			page.getByText(/You'll stop being a member of/),
			'the only admin is told they will stop being a member'
		).toHaveCount(0);
		await expect(page.getByText(LIBRARY_WORDS)).toHaveCount(0);
		await expect(currentBadge(page, name), 'the sole admin left anyway').toBeVisible();
		await holdForRecording(page);
	}
);

test(
	'an admin renames their workspace and the new name shows in the list and on the account row after a reload, and the old name never comes back once the form closes (CUR-3960)',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, FLAGS);
		await signInAsFreshUser(page, freshTestEmail());
		await dismissWelcome(page);
		const stamp = Date.now();
		const before = `E2E Typo ${stamp}`;
		const after = `E2E Renamed ${stamp}`;
		// Creating sets the new workspace active for this session.
		await api(page, baseURL!, 'create', { name: before, slug: slugify(before) });

		await page.goto('/chat/settings/workspace');
		await page.getByRole('button', { name: 'Rename…' }).click({ timeout: 30_000 });
		await page.getByRole('textbox', { name: 'Workspace name' }).fill(after);
		// The form closed on the save's answer and the heading and account row showed the old
		// name for about two seconds before the reload caught up (CUR-3960). Every DOM change after Save is checked:
		// once the form is gone, the heading and the account row must already read the new name.
		await page.evaluate((renamed) => {
			const seen: string[] = [];
			(window as unknown as { __staleRename: string[] }).__staleRename = seen;
			const check = () => {
				const formOpen = [...document.querySelectorAll('label')].some(
					(l) => l.textContent?.includes('Workspace name') && l.querySelector('input')
				);
				if (formOpen) return;
				const heading = document.querySelector('h2.type-heading')?.textContent?.trim();
				const account = document.querySelector('[data-account-status]')?.textContent?.trim();
				if (heading !== renamed || (account !== undefined && account !== renamed))
					seen.push(`heading "${heading}", account row "${account}"`);
			};
			new MutationObserver(check).observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true
			});
		}, after);
		await page.getByRole('button', { name: 'Save name' }).click();
		await expect(workspaceList(page).getByRole('button', { name: after })).toBeVisible({
			timeout: 15_000
		});
		await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveCount(0);
		expect(
			await page.evaluate(() => (window as unknown as { __staleRename: string[] }).__staleRename),
			'the rename form closed while the page still showed the old name'
		).toEqual([]);

		await page.reload({ waitUntil: 'load' });
		await expect(workspaceList(page).getByRole('button', { name: after })).toBeVisible({
			timeout: 30_000
		});
		await expect(workspaceList(page).getByRole('button', { name: before })).toHaveCount(0);
		await expect(accountButton(page).locator('[data-account-status]')).toHaveText(after);
		await holdForRecording(page);
	}
);

// A workspace's name goes into the invitation email a stranger receives, so a name carrying
// a link is refused by the server on create and on rename, not only shortened by the page's input (CUR-3194).
test(
	'a workspace name carrying a web address is refused on create and on rename, and nothing is created',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, FLAGS);
		await signInAsFreshUser(page, freshTestEmail());
		await dismissWelcome(page);
		const stamp = Date.now();
		const spammy = `Claim your prize at prize-${stamp}.example`;

		await journeyStep(page, 'A8', 18, async () => {
			await page.goto('/chat/settings/workspace');
			await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
				timeout: 30_000
			});
			await page.getByPlaceholder("Your organisation or group's name").fill(spammy);
			await page.getByRole('button', { name: 'Create', exact: true }).click();
			await expect(
				page.getByText(/can't contain a link/i),
				'a workspace name with a web address in it was not refused'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				workspaceList(page).getByRole('button', { name: spammy }),
				'the refused workspace was created anyway'
			).toHaveCount(0);
			await holdForRecording(page);
		});

		// Rename goes through the API too, which skips the page's input entirely.
		const name = `E2E Link Rename ${stamp}`;
		const { id: organizationId } = await api(page, baseURL!, 'create', {
			name,
			slug: slugify(name)
		});
		const rename = await page.request.post('/chat/api/auth/organization/update', {
			data: { organizationId, data: { name: `Visit www.prize-${stamp}.example` } },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(rename.status(), 'a rename to a web address was accepted').toBe(400);
		const orgs = (await (await page.request.get('/chat/api/auth/organization/list')).json()) as {
			name: string;
		}[];
		expect(orgs.map((o) => o.name)).toContain(name);
		expect(orgs.map((o) => o.name).join(' ')).not.toContain('prize-');
	}
);
