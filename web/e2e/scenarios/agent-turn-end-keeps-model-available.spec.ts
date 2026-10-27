// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { agentOption, openAgentTools } from './helpers/agentTool';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// An agent turn the route's generation watchdog ends (the way a turn with an approval nobody
// answers ends, CUR-4660) arrives as a 504. The tab used to read any 5xx as the chosen model failing and
// marked it busy for ten minutes, so the composer said "Mistral Medium 3.5 is unavailable right now"
// while Medium answered everyone else. The agent served that turn without ever calling the chosen
// model, which must stay on offer afterwards.
//
// `agent_turn_deadline_20s` cuts an agent turn's watchdog to 20s (see agent-outlives-the-tab.spec.ts),
// so it fires without a three-minute wait. Reachable by a minted `@example.org` account on preview, as
// in agent-file-download.spec.ts.

test(
	'an agent turn the watchdog ends leaves the chosen model available: no "unavailable right now" notice under the composer',
	{ tag: ['@preview-only', '@F2', '@CUR-4661'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await setFlagOverrides(context, baseURL!, { 'agent-mode': true });
		await signInAsFreshUser(page);
		await installFaultInjectionHeader(page, 'agent_turn_deadline_20s');

		const composer = page.getByLabel('Message AI Potluck');
		const refusedAtCapacity = 'The agent is at capacity right now';
		// The develop agent app refuses runs past its concurrency with an answer, not a 504; send again in
		// a new conversation up to four times, as agent-outlives-the-tab.spec.ts does.
		for (let attempt = 1; ; attempt++) {
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			await composer.click({ timeout: 30_000 });
			await openAgentTools(page, { timeout: 15_000 });
			await agentOption(page, 'On').click();
			await page.keyboard.press('Escape');
			const nonce = randomBytes(6).toString('hex');
			await composer.fill(
				`Write ten paragraphs on why shared community meals work, each about a different reason. End your reply in this chat with the exact line: receipt ${nonce}`
			);
			await composer.press('Enter');
			const turn = page.locator('[data-message-role="assistant"]').last();
			await expect(turnDone(turn), 'the agent turn never ended').toBeVisible({ timeout: 120_000 });
			const text = (await turn.textContent()) ?? '';
			if (!text.includes(refusedAtCapacity)) {
				expect(text, 'the run beat the 20s deadline, so the watchdog never fired').not.toContain(
					`receipt ${nonce}`
				);
				// The watchdog's 504 is what the tab used to read as the model failing; without it this
				// spec would measure nothing.
				await expect(
					turn,
					'the turn did not end on the watchdog, so the case under test never happened'
				).toContainText('took too long to respond');
				break;
			}
			test.info().annotations.push({
				type: 'agent-capacity',
				description: `attempt ${attempt}: the agent app refused the run at capacity`
			});
			expect(
				attempt,
				'the agent app refused the run at capacity on all four attempts'
			).toBeLessThan(4);
		}

		await composer.fill('And one more paragraph, please.');
		await expect(
			page.locator('[data-model-unavailable-notice]'),
			'the composer calls the chosen model unavailable after an agent turn it never answered'
		).toHaveCount(0);
	}
);
