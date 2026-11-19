import { test, expect, chromium, type Page } from '@playwright/test';
import { setupRecast, narrate, click, typeText } from 'playwright-recast/helpers';
import { highlight, waitForNarration, openHome, clickIntoChat, TOUR_RECAST } from './show';
import { tourEmail } from '../../scripts/lib/tourPersonas.mjs';
import { signInWithEmailOtp } from '../scenarios/helpers/signIn';
import {
	accountButton,
	openWorkspaceSettings,
	workspaceFlyout
} from '../scenarios/helpers/accountMenu';
import { setFlagOverrides } from '../scenarios/helpers/flagOverride';
import { turnDone } from '../scenarios/helpers/turn';

// The A8 walkthrough, short: docs/journeys/a8-workspaces.md's create and switch, walked as one
// signed-in person. Sign-in is A1's tour, so it happens off camera in a browser of its own and the
// take starts signed in, on the home page. It also films Remove asking first and never offered on the
// admin's own row, and the chat from a workspace she left sitting under "Former: <team>".
// Last, a workspace deleted under her lands her in Personal rather than her other team
// workspace, and Settings → Workspace says why.
//
// It is filmed for people. workspaces.spec.ts holds the assertions; the expects here are only the
// ones a viewer would notice going wrong, so a broken take fails instead of rendering.
// Every narrate() line is the voiceover, read by tools/tour-render from this run's trace.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const EMAIL = tourEmail('priya.natarajan');
const WORKSPACE = `Lakeside Library ${Math.random().toString(36).slice(2, 5)}`;
const RENAMED = `${WORKSPACE} Friends`;
const INVITEE = tourEmail('sam.okafor');
const FLAGS = { 'workspace-org-creation': true };
const OWN = `Priya's Projects ${Math.random().toString(36).slice(2, 5)}`;
const CIRCLE = `Reading Circle ${Math.random().toString(36).slice(2, 5)}`;

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
	// Two sign-ins off camera and one model turn on develop.
	test.setTimeout(480_000);
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

	// The same switch from the rail, without opening Settings.
	await narrate('From any chat, the account menu switches too, without a trip to Settings.');
	await page.goto('/chat', { waitUntil: 'load' });
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	let flyout = await workspaceFlyout(page, { timeout: 30_000 });
	const option = (name: string) => flyout.getByRole('menuitemradio', { name, exact: true });
	await highlight(option(WORKSPACE));
	await click(option('Personal workspace'));
	// A switch that lands closes the menu, so the chat list it changed is in view.
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

	// Sam joins so Priya can hand over admin, rename the group, then leave it.
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

	// Remove asks first, and is never offered on the admin's own row. The take cancels, so
	// Sam stays to take over the group below.
	const removeButtons = page.getByRole('button', { name: /^Remove .+…$/ });
	await expect(removeButtons, 'Remove is offered on Priya’s own row').toHaveCount(1);
	await narrate(
		'Removing someone asks first. Remove sits on Sam’s row only; an admin cannot remove herself here.'
	);
	await click(removeButtons.first());
	const removeConfirm = page.getByTestId('workspace-remove-confirm');
	await expect(removeConfirm).toContainText('They lose access to it straight away', {
		timeout: 10_000
	});
	await highlight(removeConfirm);
	await waitForNarration(page);
	await narrate('Priya keeps Sam, so she cancels.');
	await click(removeConfirm.getByRole('button', { name: 'Cancel', exact: true }));
	await expect(removeConfirm).toBeHidden({ timeout: 10_000 });
	await expect(samAs('Admin')).toBeVisible();
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

	// One chat in the workspace, so leaving it has something to keep under Former.
	await narrate('Priya starts a chat for the group, in the group’s workspace.');
	await page.goto('/chat', { waitUntil: 'load' });
	const composer = page.getByLabel('Message AI Potluck');
	await expect(composer).toBeVisible({ timeout: 30_000 });
	await expect(accountStatus).toHaveText(RENAMED, { timeout: 15_000 });
	await click(composer);
	await typeText(composer, 'Write a two-line welcome for new library volunteers.');
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
		timeout: 120_000
	});
	await waitForNarration(page);
	await openWorkspaceSettings(page, { timeout: 30_000 });
	await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
	await click(row(RENAMED));

	// Leave is offered only because Sam is an admin too; a sole admin is told they can't.
	await narrate(
		'Later Priya hands the group to Sam and leaves. She can, because Sam is an admin too: the only admin is told they cannot.'
	);
	await click(page.getByRole('button', { name: 'Leave workspace…' }));
	await click(page.getByRole('button', { name: 'Leave workspace', exact: true }));
	await expect(accountStatus).toHaveText('Personal workspace', { timeout: 30_000 });
	await expect(row(RENAMED)).toHaveCount(0, { timeout: 15_000 });
	await highlight(page.getByRole('status').filter({ hasText: `You left ${RENAMED}` }));
	await waitForNarration(page);

	// Her chats from it sit together under "Former: <team>", not mixed into Personal.
	await page.reload({ waitUntil: 'load' });
	const former = page.getByRole('button', { name: `Former: ${RENAMED}` });
	await expect(former, 'the chat from the workspace she left has no Former entry').toBeVisible({
		timeout: 30_000
	});
	await narrate(
		'Her chat from the group is not mixed into Personal. It sits under Former workspaces, readable, but not continued.'
	);
	await highlight(former);
	await waitForNarration(page);

	// A workspace deleted under her lands her in Personal, never in another team workspace she is in,
	// and Settings → Workspace says why, through a reload. Off camera: Priya makes
	// a workspace of her own, Sam makes a reading circle and invites her, and she works in the circle.
	const origin = { origin: new URL(baseURL!).origin };
	const slug = (name: string) => name.toLowerCase().replace(/\W+/g, '-');
	const orgCall = async (on: Page, path: string, data: object) => {
		const res = await on.request.post(`/chat/api/auth/organization/${path}`, {
			data,
			headers: origin
		});
		expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
		return (await res.json()) as { id: string };
	};
	await orgCall(page, 'create', { name: OWN, slug: slug(OWN) });
	const circleBrowser = await chromium.launch();
	try {
		const samContext = await circleBrowser.newContext({ baseURL });
		await setFlagOverrides(samContext, baseURL!, FLAGS);
		const samPage = await samContext.newPage();
		await signInWithEmailOtp(samPage, DATABASE_URL!, INVITEE, { skipPendingLabelCheck: true });
		const circle = await orgCall(samPage, 'create', { name: CIRCLE, slug: slug(CIRCLE) });
		const invite = await orgCall(samPage, 'invite-member', {
			organizationId: circle.id,
			email: EMAIL,
			role: 'member'
		});
		await orgCall(page, 'accept-invitation', { invitationId: invite.id });
		await orgCall(page, 'set-active', { organizationId: circle.id });

		await page.reload({ waitUntil: 'load' });
		await expect(isCurrent(CIRCLE)).toBeVisible({ timeout: 30_000 });
		await expect(row(OWN)).toBeVisible();
		await narrate(
			'Months on, Priya has a workspace of her own, and Sam has invited her to a reading circle. She is working in the circle.'
		);
		await highlight(isCurrent(CIRCLE));
		await waitForNarration(page);

		// Off camera: Sam, the circle's admin, deletes it.
		await orgCall(samPage, 'delete', { organizationId: circle.id });
	} finally {
		await circleBrowser.close();
	}

	await narrate('Then Sam deletes the reading circle.');
	await page.reload({ waitUntil: 'load' });
	await expect(row(CIRCLE)).toHaveCount(0, { timeout: 30_000 });
	await expect(
		isCurrent('Personal workspace'),
		'losing the current workspace did not land Priya in Personal'
	).toBeVisible({ timeout: 30_000 });
	await expect(
		isCurrent(OWN),
		'losing the current workspace moved Priya into her other team workspace'
	).toHaveCount(0);
	const why = list.getByRole('status');
	await expect(why, 'nothing says why Priya is in Personal').toContainText('was deleted', {
		timeout: 15_000
	});
	await expect(accountStatus).toHaveText('Personal workspace', { timeout: 15_000 });
	await narrate(
		'She lands in Personal, not in her other workspace, and Settings says why: the workspace she was in was deleted.'
	);
	await highlight(why);
	await waitForNarration(page);

	await narrate(
		'That is A8: a place for the group, kept apart from your own, one click either way.'
	);
	await waitForNarration(page);
});
