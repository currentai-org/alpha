import { expect } from './test';
import type { Page } from '@playwright/test';
import { openWorkspaceSettings } from './accountMenu';
import { chatEntry } from './chatEntry';

// Chats from a workspace the person left, or that was deleted, sit together under one
// "Former: <name>" row in the workspace list instead of mixing into Personal.

/** Opens Settings → Workspace from the account menu, picks "Former: <name>", and goes back to chat. */
export async function viewFormerWorkspace(page: Page, name: string) {
	await openWorkspaceSettings(page, { timeout: 30_000 });
	await page.waitForURL(/\/chat\/settings\/workspace/, { timeout: 30_000 });
	const row = page.getByRole('button', { name: `Former: ${name}` });
	await expect(row, `no "Former: ${name}" row in the workspace list`).toBeVisible({
		timeout: 30_000
	});
	await row.click();
	await expect(row.getByText('Viewing', { exact: true })).toBeVisible({ timeout: 15_000 });
	await page.goto(chatEntry(), { waitUntil: 'load' });
}

/** An open chat from a former workspace says why it is read-only and offers no composer. */
export async function expectReadOnlyFormerChat(page: Page, name: string) {
	await expect(
		page.getByText(`This chat was in ${name}, which you're no longer part of, so it's read-only.`)
	).toBeVisible({ timeout: 30_000 });
	await expect(
		page.getByLabel('Message AI Potluck'),
		'a chat from a former workspace still offers a composer'
	).toHaveCount(0);
}
