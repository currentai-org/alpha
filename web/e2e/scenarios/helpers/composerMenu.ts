import { expect, type Locator, type Page } from '@playwright/test';

// The composer's [+] menu holds Attach files and every composer tool (composerTools.ts). Each tool is a
// flyout: its row in the menu shows the current mode, and the flyout holds a radio group named after
// the tool, one captioned option per mode. The button names every tool it holds
// ("Add files and tools: web search, read aloud").

const PLUS_NAME = /^Add files and tools/;

export const plusButton = (page: Page, name: RegExp = PLUS_NAME): Locator =>
	page.getByRole('button', { name });
export const toolGroup = (page: Page, tool: string): Locator =>
	page.getByRole('group', { name: tool, exact: true });
const toolRow = (page: Page, tool: string): Locator =>
	page.getByRole('menuitem', { name: new RegExp(`^${tool}\\b`) });

/**
 * Opens the + menu and the tool's flyout, retrying a click that lands before hydration. `open.timeout`
 * bounds the retry. `plusName` is the button's name in another interface language.
 */
export async function openComposerTool(
	page: Page,
	tool: string,
	open: { timeout: number },
	plusName?: RegExp
): Promise<void> {
	await expect(async () => {
		if (!(await toolGroup(page, tool).isVisible())) {
			if (!(await toolRow(page, tool).isVisible()))
				await plusButton(page, plusName).click({ timeout: 2_000 });
			await toolRow(page, tool).click({ timeout: 2_000 });
		}
		await expect(toolGroup(page, tool)).toBeVisible({ timeout: 1_000 });
	}, `the + menu never showed the ${tool} options`).toPass(open);
}

/** Closes the + menu and any flyout open in it, so the composer takes input again. */
export async function closeComposerMenu(page: Page): Promise<void> {
	await expect(async () => {
		if ((await page.getByRole('menu').count()) > 0) await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 500 });
	}, 'the + menu never closed').toPass({ timeout: 5_000 });
}
