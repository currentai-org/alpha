// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { agentOption, openAgentTools } from './helpers/agentTool';
import { startChattingPastWelcome } from './helpers/welcome';

// A person attached meeting minutes, then asked the agent on the next turn for a follow-up
// email. The agent request cut every earlier turn to its first 600 characters, and the document's text
// comes first in its turn, so the minutes' last paragraph (the party's date and place) never reached the
// agent. It invented both and then said the minutes did not give them.
//
// The file's last line is a `receipt <nonce>` line past that cut. The scenario suite's stand-in agent
// (fakeAgentService.ts) ends its answer with the last receipt line in the prompt it was sent, so the
// answer carries the nonce only if the whole file reached the agent on the later turn. Turn one runs with
// the agent off, so no earlier agent answer can carry the nonce forward instead.
test(
	'the agent reads the whole of a file attached on an earlier turn, not its first 600 characters',
	{ tag: ['@preview-only', '@CUR-4104'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await setFlagOverrides(context, baseURL!, { 'agent-mode': true });
		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		const setAgent = async (mode: 'Off' | 'On') => {
			await openAgentTools(page, { timeout: 15_000 });
			await agentOption(page, mode).click();
			await expect(
				agentOption(page, mode),
				`the Agent group never marked "${mode}" as chosen`
			).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
			await page.keyboard.press('Escape');
		};

		const nonce = randomBytes(6).toString('hex');
		const tasks = Array.from(
			{ length: 8 },
			(_, i) =>
				`Task ${i + 1}: bring the tables and chairs for the street party, owner neighbour ${i + 1}.`
		).join('\n');
		const minutes = `${tasks}\nThe party is on 8 November at the square.\nreceipt ${nonce}\n`;
		expect(
			minutes.indexOf(`receipt ${nonce}`),
			'the receipt line must sit past the old 600-character cut'
		).toBeGreaterThan(600);
		const name = `minutes-${nonce}.txt`;

		await setAgent('Off');
		await expect(async () => {
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(minutes) });
			await expect(page.getByText(name).first()).toBeVisible({ timeout: 5_000 });
		}).toPass({ timeout: 45_000 });
		await composer.fill('List the tasks in these minutes.');
		await composer.press('Enter');
		const first = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(first), 'the first turn did not finish').toBeVisible({
			timeout: 120_000
		});

		await setAgent('On');
		await composer.fill('Write the follow-up email to the volunteers.');
		await composer.press('Enter');
		const second = page.locator('[data-message-role="assistant"]').nth(1);
		await expect(turnDone(second), 'the agent turn did not finish').toBeVisible({
			timeout: 150_000
		});
		await expect(
			second,
			'the agent answer does not end with the receipt from the end of the earlier file, so the agent was sent only part of it'
		).toContainText(`receipt ${nonce}`);
	}
);
