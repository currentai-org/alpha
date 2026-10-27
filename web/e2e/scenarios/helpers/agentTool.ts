import { type Locator, type Page } from '@playwright/test';
import { openComposerTool, plusButton, toolGroup } from './composerMenu';

// Agent mode lives in the composer's + menu: an "Agent" flyout holding a radio group with one captioned
// option per mode (composerTools.ts). The + button names every tool it holds ("Add files and tools: web
// search, agent, …"), and an active mode also shows an "Agent" chip beside it whose × turns it off.

export type AgentMode = 'Off' | 'Auto' | 'On';

export const toolsButton = (page: Page): Locator => plusButton(page);
export const agentGroup = (page: Page): Locator => toolGroup(page, 'Agent');
export const agentOption = (page: Page, mode: AgentMode): Locator =>
	agentGroup(page).getByRole('menuitemradio', { name: new RegExp(`^${mode}\\b`) });

/** Opens the + menu's Agent flyout, retrying a click that lands before hydration. `open` bounds the retry. */
export async function openAgentTools(page: Page, open: { timeout: number }): Promise<void> {
	await openComposerTool(page, 'Agent', open);
}

/** The mode the Agent group marks as chosen, from its checked option's name. */
export async function checkedAgentMode(page: Page): Promise<string> {
	const checked = agentGroup(page).locator('[role="menuitemradio"][aria-checked="true"]');
	return ((await checked.first().innerText()).split('\n')[0] ?? '').trim();
}
