import { expect, type Locator, type Page } from '@playwright/test';

// "Log in", "Log out" and "Account" live in the account menu at the foot of the sidebar, whose button
// is named "Account — guest" or "Account — signed in as <name>" (AccountMenu.svelte). A click that lands
// before hydration does nothing, so this retries until the item shows, then returns it.

/** The account menu's button: the one a person can see (the rail and a phone drawer can both mount it). */
export function accountButton(page: Page | Locator): Locator {
	return page.locator('[data-account-trigger]:visible').first();
}

/** Opens the account menu and returns its item named `name`. `open` bounds the whole retry. */
export async function accountMenuItem(
	page: Page,
	name: string | RegExp,
	open: { timeout: number }
): Promise<Locator> {
	const item = page.getByRole('menuitem', { name });
	await expect(async () => {
		if (!(await item.isVisible())) await accountButton(page).click({ timeout: 2_000 });
		await expect(item).toBeVisible({ timeout: 1_000 });
	}, `the account menu never offered "${name}"`).toPass(open);
	return item;
}

/** Opens the account menu's Workspace flyout (CUR-3097) and returns it. The row's name carries the
 *  current workspace ("Workspace Personal"), so it is matched from the start. */
export async function workspaceFlyout(page: Page, open: { timeout: number }): Promise<Locator> {
	const flyout = page.locator('[data-workspace-flyout]');
	await expect(async () => {
		if (!(await flyout.isVisible())) {
			await (
				await accountMenuItem(page, /^Workspace/, { timeout: 5_000 })
			).click({ timeout: 2_000 });
		}
		await expect(flyout).toBeVisible({ timeout: 1_000 });
	}, 'the account menu never opened its Workspace flyout').toPass(open);
	return flyout;
}

/** Account menu → Workspace → "Manage workspaces…", the way a person reaches Settings → Workspace. */
export async function openWorkspaceSettings(page: Page, open: { timeout: number }): Promise<void> {
	const flyout = await workspaceFlyout(page, open);
	await flyout.getByRole('menuitem', { name: 'Manage workspaces…' }).click();
}
