// e2e-product: @chat
// e2e-area: @agent
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { agentOption, openAgentTools } from './helpers/agentTool';
import { startChattingPastWelcome } from './helpers/welcome';

// agent-service caps each visitor's agent tasks per day, and chat answered that 429 the way
// it answers a full machine: "at capacity, wait a moment and try again". Waiting does nothing for a
// daily cap. The stand-in's `daily_limit` knob answers the run with that cap's own 429 body, so the
// person should read that today's limit is reached.
test(
	'an agent turn past the daily task limit says the limit is reached, not "wait a moment"',
	{ tag: ['@preview-only', '@CUR-4401', '@agent-knob:daily_limit'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await setFlagOverrides(context, baseURL!, { 'agent-mode': true });
		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'On').click();
		await expect(agentOption(page, 'On')).toHaveAttribute('aria-checked', 'true', {
			timeout: 10_000
		});
		await page.keyboard.press('Escape');

		await composer.fill('Write a short shopping list for a street party to a file.');
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(answer).toContainText("Agent mode has reached today's task limit", {
			timeout: 60_000
		});
		await expect(answer).not.toContainText('wait a moment');
	}
);
