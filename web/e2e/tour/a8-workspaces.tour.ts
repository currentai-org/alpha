import { test, expect, chromium, type Page } from '@playwright/test';
import { setupRecast, narrate, click, typeText } from 'playwright-recast/helpers';
import { highlight, waitForNarration, openHome, clickIntoChat, TOUR_RECAST } from './show';
import { signInWithEmailOtp } from '../scenarios/helpers/signIn';
import {
	accountButton,
	openWorkspaceSettings,
	workspaceFlyout
} from '../scenarios/helpers/accountMenu';
import { setFlagOverrides } from '../scenarios/helpers/flagOverride';

// The A8 walkthrough, short: docs/journeys/a8-workspaces.md's create and switch, walked as one
// signed-in person. Sign-in is A1's tour, so it happens off camera in a browser of its own and the
// take starts signed in, on the home page.
//
// It is filmed for people. workspaces.spec.ts holds the assertions; the expects here are only the
// ones a viewer would notice going wrong, so a broken take fails instead of rendering.
// Every narrate() line is the voiceover, read by tools/tour-render from this run's trace.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const EMAIL = `priya.natarajan.${Math.random().toString(36).slice(2, 7)}@example.org`;
const WORKSPACE = `Lakeside Library ${Math.random().toString(36).slice(2, 5)}`;
const RENAMED = `${WORKSPACE} Friends`;
const INVITEE = `sam.okafor.${Math.random().toString(36).slice(2, 7)}@example.org`;
const FLAGS = { workspaces: true, 'workspace-org-creation': true };

/** The id of the pending invitation for `email` in the admin's workspace named `name`. */
async function pendingInvitationId(page: Page, name: string, email: string): Promise<string> {
	const orgs = (await (await page.request.get('/chat/api/auth/organization/list')).json()) as {
		id: string;
		name: string;
	}[];
	const org = orgs.find((o) => o.name === name);
	expect(org, `${name} is not among the admin's workspaces`).toBeTruthy();
	const invitations = (await (
		await page.request.get('/chat/api/auth/organization/list-invitations', {
			params: { organizationId: org!.id }
		})
	).json()) as { id: string; email: string; status: string }[];
	const invitation = invitations.find((i) => i.email === email && i.status === 'pending');
	expect(invitation, `no pending invitation for ${email}`).toBeTruthy();
	return invitation!.id;
}

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

test('A8: make a workspace for your group, and switch between it and your own', async ({
	page,
	context,
	baseURL
}) => {
	expect(DATABASE_URL, 'SCENARIO_DATABASE_URL is needed to read the sign-in code').toBeTruthy();
	await setFlagOverrides(context, baseURL!, FLAGS);

	// Off camera: sign in by email code in a browser of its own, then hand its cookies to the take.
	const signInBrowser = await chromium.launch();
	try {
		const signInContext = await signInBrowser.newContext({ baseURL });
		const signInPage = await signInContext.newPage();
		await signInWithEmailOtp(signInPage, DATABASE_URL!, EMAIL, { skipPendingLabelCheck: true });
		await context.addCookies(await signInContext.cookies());
	} finally {
		await signInBrowser.close();
	}

	await openHome(page);
	await narrate(
		'This is A8, workspaces. Priya runs a volunteer group and wants its chats kept apart from her own.'
	);
	await waitForNarration(page);
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);
	const accountStatus = accountButton(page).locator('[data-account-status]');

	await narrate('Workspace sits in the account menu.');
	await openWorkspaceSettings(page, { timeout: 30_000 });
	await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
	await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible({
		timeout: 30_000
	});
	await narrate('Everyone starts in Personal. Making a workspace takes a name and nothing else.');
	const nameInput = page.getByPlaceholder("Your organisation or group's name");
	await click(nameInput);
	await typeText(nameInput, WORKSPACE);
	await waitForNarration(page);
	await click(page.getByRole('button', { name: 'Create', exact: true }));

	// Scoped to the list: the account row in the rail also reads the workspace's name.
	const list = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Your workspaces', exact: true }) });
	const row = (name: string) => list.getByRole('button', { name });
	const isCurrent = (name: string) => row(name).getByText('Current', { exact: true });
	await expect(isCurrent(WORKSPACE)).toBeVisible({ timeout: 15_000 });
	await expect(accountStatus).toHaveText(WORKSPACE, { timeout: 15_000 });
	await narrate(
		'The new workspace is the current one, and the account row in the rail says so, so new chats land in the right place.'
	);
	await page
		.getByRole('heading', { name: 'Your workspaces', exact: true })
		.scrollIntoViewIfNeeded();
	await highlight(isCurrent(WORKSPACE));
	await waitForNarration(page);

	await narrate('Back to her own chats is one click on Personal.');
	await click(row('Personal workspace'));
	await expect(isCurrent(WORKSPACE)).toHaveCount(0, { timeout: 15_000 });
	await expect(accountStatus).not.toHaveText(WORKSPACE, { timeout: 15_000 });
	await waitForNarration(page);

	await narrate('And one click back. A reload keeps the choice, because the server holds it.');
	await click(row(WORKSPACE));
	await expect(isCurrent(WORKSPACE)).toBeVisible({ timeout: 15_000 });
	await page.reload({ waitUntil: 'load' });
	await expect(isCurrent(WORKSPACE)).toBeVisible({ timeout: 30_000 });
	await highlight(accountStatus);
	await waitForNarration(page);

	// The same switch from the rail, without opening Settings (CUR-3097).
	await narrate('From any chat, the account menu switches too, without a trip to Settings.');
	await page.goto('/chat', { waitUntil: 'load' });
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	let flyout = await workspaceFlyout(page, { timeout: 30_000 });
	const option = (name: string) => flyout.getByRole('menuitemradio', { name, exact: true });
	await highlight(option(WORKSPACE));
	await click(option('Personal workspace'));
	// A switch that lands closes the menu, so the chat list it changed is in view (CUR-3174).
	await expect(accountStatus).toHaveText('Personal workspace', { timeout: 15_000 });
	await expect(flyout).toBeHidden({ timeout: 15_000 });
	await waitForNarration(page);
	await narrate(
		'The menu closes on the new chat list. Open it again and a check marks where she is.'
	);
	flyout = await workspaceFlyout(page, { timeout: 30_000 });
	await expect(option('Personal workspace')).toBeChecked({ timeout: 5_000 });
	await highlight(option('Personal workspace'));
	await click(option(WORKSPACE));
	await expect(accountStatus).toHaveText(WORKSPACE, { timeout: 15_000 });
	// The switch has landed by now, so the menu is already closing.
	await expect(flyout).toBeHidden({ timeout: 1_000 });
	await highlight(accountStatus);
	await waitForNarration(page);

	// Sam joins so Priya can hand over admin, rename the group, then leave it (CUR-3106).
	await narrate('Inviting her group happens on the settings page.');
	await openWorkspaceSettings(page, { timeout: 30_000 });
	await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
	await click(row(WORKSPACE));
	const inviteInput = page.getByPlaceholder('name@example.org');
	await expect(inviteInput).toBeVisible({ timeout: 30_000 });
	await click(inviteInput);
	await typeText(inviteInput, INVITEE);
	await click(page.getByRole('button', { name: 'Invite', exact: true }));
	const pending = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'Pending invitations' }) });
	await expect(pending.getByText(INVITEE, { exact: true })).toBeVisible({ timeout: 15_000 });
	await waitForNarration(page);

	// Off camera: Sam signs in on their own device and accepts.
	const invitationId = await pendingInvitationId(page, WORKSPACE, INVITEE);
	const samBrowser = await chromium.launch();
	try {
		const samContext = await samBrowser.newContext({ baseURL });
		await setFlagOverrides(samContext, baseURL!, FLAGS);
		const samPage = await samContext.newPage();
		await signInWithEmailOtp(samPage, DATABASE_URL!, INVITEE, { skipPendingLabelCheck: true });
		const accepted = await samPage.request.post('/chat/api/auth/organization/accept-invitation', {
			data: { invitationId },
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(accepted.status(), `Sam's accept answered ${accepted.status()}`).toBe(200);
	} finally {
		await samBrowser.close();
	}

	await page.reload({ waitUntil: 'load' });
	await click(row(WORKSPACE));
	const samAs = (role: 'Admin' | 'Member') =>
		page.getByText(`${INVITEE} · ${role}`, { exact: true });
	await expect(samAs('Member')).toBeVisible({ timeout: 30_000 });
	await narrate('Sam accepted on their own phone. An admin can make another admin.');
	await click(page.getByRole('button', { name: 'Make admin' }));
	await expect(samAs('Admin')).toBeVisible({ timeout: 15_000 });
	await highlight(samAs('Admin'));
	await waitForNarration(page);

	await narrate('The group settled on a longer name. An admin can rename the workspace.');
	await click(page.getByRole('button', { name: 'Rename…' }));
	const renameInput = page.getByRole('textbox', { name: 'Workspace name' });
	await renameInput.fill('');
	await typeText(renameInput, RENAMED);
	await click(page.getByRole('button', { name: 'Save name' }));
	await expect(row(RENAMED)).toBeVisible({ timeout: 15_000 });
	await expect(accountStatus).toHaveText(RENAMED, { timeout: 15_000 });
	await highlight(accountStatus);
	await waitForNarration(page);

	// Leave is offered only because Sam is an admin too (CUR-4020); a sole admin is told they can't.
	// Priya has no chats in the workspace, so no Former workspaces section appears to point at.
	await narrate(
		'Later Priya hands the group to Sam and leaves. She can, because Sam is an admin too: the only admin is told they cannot.'
	);
	await click(page.getByRole('button', { name: 'Leave workspace…' }));
	await click(page.getByRole('button', { name: 'Leave workspace', exact: true }));
	await expect(accountStatus).toHaveText('Personal workspace', { timeout: 30_000 });
	await expect(row(RENAMED)).toHaveCount(0, { timeout: 15_000 });
	await highlight(page.getByRole('status').filter({ hasText: `You left ${RENAMED}` }));
	await waitForNarration(page);

	await narrate(
		'That is A8: a place for the group, kept apart from your own, one click either way.'
	);
	await waitForNarration(page);
});
