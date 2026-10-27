// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { agentOption, openAgentTools } from './helpers/agentTool';
import { startChattingPastWelcome } from './helpers/welcome';

// Agent auto mode, the default for everyone. Making a file and changing it open
// no approval card, the trace lists both as "ran without asking", and a delete still asks with a plain
// sentence for a headline. A person who turns on Settings → Personalization → "Ask before every step"
// gets a card for the same request, and so does everyone while the `agent-auto-mode` kill switch is off.
//
// The file name carries a nonce minted here, so a pass cannot come from an earlier run's workdir.
// Reachable by a minted @example.org account on preview for the reason agent-file-download.spec.ts
// gives (`agent-mode-access`, CUR-1611); the flags are forced through the override cookie.
// @preview-only: the override cookie is not wired on production, and agent mode is off there.
// `@real-agent` (SOL-212): only agent-service decides what runs without a card, and the in-process
// stand-in has no approval path, so these run on develop's push run against the develop agent pair
// and a PR's run leaves them out.

const CARD = 'This turn wants to:';

async function agentOn(page: Page, beforeChat?: () => Promise<void>) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await signInAsFreshUser(page);
	await beforeChat?.();
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	// "On", not "Auto": auto would let the router call the turn plain chat, and then nothing is asked.
	await openAgentTools(page, { timeout: 15_000 });
	await agentOption(page, 'On').click();
	await expect(agentOption(page, 'On')).toHaveAttribute('aria-checked', 'true', {
		timeout: 10_000
	});
	await page.keyboard.press('Escape');
	return composer;
}

async function send(page: Page, composer: ReturnType<Page['getByLabel']>, text: string) {
	const before = await page.locator('[data-message-role="assistant"]').count();
	await composer.fill(text);
	await composer.press('Enter');
	await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(before + 1, {
		timeout: 30_000
	});
	return page.locator('[data-message-role="assistant"]').last();
}

// The trace sits in the reasoning panel, which closes itself when the turn ends and then holds no
// text in the page (OpenReasoningResults.svelte). Open it the way a person would before reading it.
async function openTrace(turn: ReturnType<Page['locator']>) {
	await turn.getByRole('button', { name: 'Expand' }).first().click({ timeout: 10_000 });
	return turn;
}

test(
	'auto mode makes and changes a file with no approval card, lists both in the trace, and asks in plain words before a delete',
	{ tag: ['@preview-only', '@A7', '@CUR-3142', '@CUR-4486', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		// Three agent turns, each a sandbox and several model rounds.
		test.setTimeout(600_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-confirm-ui': true,
			'agent-auto-mode': true
		});
		const composer = await agentOn(page);
		const nonce = randomBytes(6).toString('hex');
		const filename = `plan-${nonce}.txt`;

		const made = await send(
			page,
			composer,
			`Create a text file named ${filename} whose only line is: potluck ${nonce}`
		);
		// A card here is the defect: poll the turn to its end and fail on the first card seen.
		await expect
			.poll(
				async () => {
					if (await page.getByText(CARD).isVisible()) return 'card';
					return (await turnDone(made).isVisible()) ? 'done' : 'running';
				},
				{ message: 'the create turn did not finish', timeout: 240_000, intervals: [1_000] }
			)
			.toBe('done');
		await expect(
			(await openTrace(made)).getByText(/ran without asking:/).first(),
			'the trace does not list the write auto mode ran, so an action happened out of sight'
		).toBeAttached();

		const changed = await send(page, composer, `Add a second line to ${filename}: second ${nonce}`);
		await expect
			.poll(
				async () => {
					if (await page.getByText(CARD).isVisible()) return 'card';
					return (await turnDone(changed).isVisible()) ? 'done' : 'running';
				},
				{ message: 'the change turn did not finish', timeout: 240_000, intervals: [1_000] }
			)
			.toBe('done');
		await expect(
			(await openTrace(changed)).getByText(/ran without asking:/).first(),
			'the trace does not list the change auto mode ran'
		).toBeAttached();

		await send(page, composer, `Delete ${filename}.`);
		const card = page.getByText(CARD).last();
		await expect(card, 'a delete ran without asking first').toBeVisible({ timeout: 240_000 });
		const headline = (await card.textContent()) ?? '';
		expect(
			headline,
			'the delete card leads with a command line instead of a plain sentence'
		).not.toMatch(/\brm\b|os\.remove|unlink|Approve (terminal|execute_code)/);
		await page.getByRole('button', { name: 'Deny', exact: true }).last().click();
	}
);

// Settings → Personalization, the way a person would reach it, and the save landing before the chat.
async function askEveryStep(page: Page) {
	await page.goto(chatPath('/settings/personalization'), { waitUntil: 'load' });
	const toggle = page.getByRole('switch', { name: 'Ask before every step' });
	await expect(toggle, 'Personalization offers no Ask before every step switch').toBeVisible({
		timeout: 20_000
	});
	await expect(toggle, 'ask before every step is on before the person chose it').not.toBeChecked();
	const saved = page.waitForResponse(
		(r) => r.request().method() === 'POST' && /\/settings\/?$/.test(new URL(r.url()).pathname),
		{ timeout: 15_000 }
	);
	await toggle.click();
	await expect(toggle).toBeChecked();
	expect((await saved).ok(), 'the switch did not save').toBe(true);
}

async function makeFileOpensACard(
	page: Page,
	composer: ReturnType<Page['getByLabel']>,
	why: string
) {
	const nonce = randomBytes(6).toString('hex');
	const made = await send(
		page,
		composer,
		`Create a text file named plan-${nonce}.txt whose only line is: potluck ${nonce}`
	);
	await expect(page.getByText(CARD).first(), why).toBeVisible({ timeout: 240_000 });
	await expect(made.getByText(/ran without asking:/)).toHaveCount(0);
	await page.getByRole('button', { name: 'Deny', exact: true }).first().click();
}

test(
	'a person who turns on Ask before every step gets an approval card for making a file',
	{ tag: ['@preview-only', '@A7', '@CUR-3142', '@CUR-4486', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-confirm-ui': true,
			'agent-auto-mode': true
		});
		const composer = await agentOn(page, () => askEveryStep(page));
		await makeFileOpensACard(
			page,
			composer,
			'the person asked before every step and a write ran without a card'
		);
	}
);

test(
	'with the agent-auto-mode kill switch off, making a file opens an approval card for everyone',
	{ tag: ['@preview-only', '@A7', '@CUR-3142', '@CUR-4486', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-confirm-ui': true,
			'agent-auto-mode': false
		});
		const composer = await agentOn(page);
		await makeFileOpensACard(
			page,
			composer,
			'the kill switch is off and a write ran without a card, so it cannot stop auto mode'
		);
	}
);

// A card nobody answers. The route's generation watchdog ends the turn while the card is
// still open (its deadline, about 155s, falls before agent-service's own 180s deny), and the person
// must be told that the approval went unanswered: the card reads as a timed-out deny and the answer
// names the unanswered approval, never "stopped" or "Canceled.", which read as though someone else
// ended the run.
test(
	'an approval card left unanswered until the turn ends reads as a timed-out deny, and the answer says the approval went unanswered',
	{ tag: ['@preview-only', '@A7', '@CUR-4660', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(480_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-confirm-ui': true,
			'agent-auto-mode': true
		});
		const composer = await agentOn(page, () => askEveryStep(page));
		const nonce = randomBytes(6).toString('hex');
		const turn = await send(
			page,
			composer,
			`Create a text file named plan-${nonce}.txt whose only line is: potluck ${nonce}`
		);
		await expect(
			page.getByText(CARD).first(),
			'the person asked before every step and no approval card opened'
		).toBeVisible({ timeout: 240_000 });

		// Nobody answers. The turn ends on its own deadline with the card still open.
		await expect(turnDone(turn), 'the turn never ended with its card unanswered').toBeVisible({
			timeout: 220_000
		});
		await expect(
			turn.getByText('No answer arrived in time — denied.').first(),
			'the unanswered card does not say it timed out'
		).toBeVisible({ timeout: 15_000 });
		await expect(turn.getByText(/— Canceled\./)).toHaveCount(0);
		await expect(turn).toContainText(
			/No answer arrived in time for the agent's (\d+ )?approval request/
		);
		await expect(turn).not.toContainText('The agent run was stopped before it finished.');
	}
);
