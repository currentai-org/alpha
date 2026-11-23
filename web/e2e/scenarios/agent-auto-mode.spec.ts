// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
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
// gives (`agent-mode-access`); the flags are forced through the override cookie.
// @preview-only: the override cookie is not wired on production, and agent mode is off there.
// `@real-agent`: only agent-service decides what runs without a card, and the in-process
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
	{ tag: ['@preview-only', '@A7', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		// Three agent turns, each a sandbox and several model rounds.
		test.setTimeout(600_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
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

		const deleting = await send(page, composer, `Delete ${filename}.`);
		const card = page.getByText(CARD).last();
		// A turn that died before asking (a full sandbox host, a model error) is not a delete that skipped
		// its card, so each fails with its own message.
		const seen: { outcome: FirstOutcome } = { outcome: 'still-running' };
		await expect
			.poll(async () => (seen.outcome = await firstOutcome(page, deleting, 'last')), {
				timeout: 240_000,
				intervals: [1_000]
			})
			.not.toBe('still-running')
			.catch(() => undefined);
		const deleteFailures: Record<Exclude<FirstOutcome, 'card'>, string> = {
			'ran-without-card':
				'a delete ran without asking first: the trace lists it as "ran without asking"',
			'ended-without-card':
				'the delete turn ended with no approval card and nothing in its trace: the agent never asked to delete',
			'still-running':
				'after 240s the delete turn showed no approval card and nothing in its trace: it had not asked yet, or its card never reached the page'
		};
		expect(seen.outcome, seen.outcome === 'card' ? '' : deleteFailures[seen.outcome]).toBe('card');
		const headline = (await card.textContent()) ?? '';
		expect(
			headline,
			'the delete card leads with a command line instead of a plain sentence'
		).not.toMatch(/\brm\b|os\.remove|unlink|Approve (terminal|execute_code)/);

		// once someone presses Allow, the card collapses to one resolved line, and that line
		// must still lead with the plain sentence the open card showed, never the raw HTML-escaped call.
		const plain = headline.replace(/^\s*This turn wants to:\s*/, '').trim();
		expect(plain, 'the delete card has no plain sentence to carry into its resolved line').not.toBe(
			''
		);
		const confirmCard = page.locator('[data-agent-confirm-card]').last();
		await confirmCard.getByRole('button', { name: 'Allow', exact: true }).click();
		const resolved = confirmCard.getByText(/— Allowed\.$/);
		await expect(resolved, 'pressing Allow did not resolve the delete card').toBeVisible({
			timeout: 30_000
		});
		const resolvedLine = ((await resolved.textContent()) ?? '').trim();
		expect(
			resolvedLine.startsWith(plain),
			`the resolved line "${resolvedLine}" does not start with the plain sentence "${plain}"`
		).toBe(true);
		expect(
			resolvedLine,
			'the resolved line shows the raw command or its HTML entities'
		).not.toMatch(/&amp;|&gt;|&lt;|Approve (terminal|execute_code)/);
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

// What the make-a-file turn did first. A write that ran without a card and a turn that never got as far
// as asking are different failures: the first is the defect these tests exist for, the second is not
// one, so each fails with its own message.
type FirstOutcome = 'card' | 'ran-without-card' | 'ended-without-card' | 'still-running';

async function firstOutcome(
	page: Page,
	turn: ReturnType<Page['locator']>,
	which: 'first' | 'last' = 'first'
): Promise<FirstOutcome> {
	const card = page.getByText(CARD);
	if (await (which === 'first' ? card.first() : card.last()).isVisible()) return 'card';
	if ((await turn.getByText(/ran without asking:/).count()) > 0) return 'ran-without-card';
	if (!(await turnDone(turn).isVisible())) return 'still-running';
	// The trace panel closes when the turn ends and then holds no text; open it before reading.
	await openTrace(turn).catch(() => undefined);
	return (await turn.getByText(/ran without asking:/).count()) > 0
		? 'ran-without-card'
		: 'ended-without-card';
}

async function makeFileOpensACard(
	page: Page,
	composer: ReturnType<Page['getByLabel']>,
	who: string
) {
	const nonce = randomBytes(6).toString('hex');
	const made = await send(
		page,
		composer,
		`Create a text file named plan-${nonce}.txt whose only line is: potluck ${nonce}`
	);
	const seen: { outcome: FirstOutcome } = { outcome: 'still-running' };
	await expect
		.poll(async () => (seen.outcome = await firstOutcome(page, made)), {
			timeout: 240_000,
			intervals: [1_000]
		})
		.not.toBe('still-running')
		// Still running at the deadline is an outcome too; the assertion below names it.
		.catch(() => undefined);
	const failures: Record<Exclude<FirstOutcome, 'card'>, string> = {
		'ran-without-card': `${who}, and a write ran without an approval card: the trace lists it as "ran without asking"`,
		'ended-without-card': `${who}, and the turn ended with no approval card and no write in its trace: the agent never asked to write`,
		'still-running': `${who}, and after 240s there was no approval card and no write in the trace: the agent had not asked to write yet, or its card never reached the page`
	};
	const { outcome } = seen;
	expect(outcome, outcome === 'card' ? '' : failures[outcome]).toBe('card');
	// visible in the DOM is not seen: a card below the fold times out to Deny unnoticed.
	await expect(
		page.locator('[data-agent-confirm-card]').first(),
		'the approval card opened out of sight and the chat did not scroll to it'
	).toBeInViewport({ timeout: 5_000 });
	await expect(made.getByText(/ran without asking:/)).toHaveCount(0);
	await page.getByRole('button', { name: 'Deny', exact: true }).first().click();
}

test(
	'a person who turns on Ask before every step gets an approval card for making a file',
	{ tag: ['@preview-only', '@A7', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-auto-mode': true
		});
		const composer = await agentOn(page, () => askEveryStep(page));
		await makeFileOpensACard(page, composer, 'the person asked before every step');
	}
);

test(
	'with the agent-auto-mode kill switch off, making a file opens an approval card for everyone',
	{ tag: ['@preview-only', '@A7', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-auto-mode': false
		});
		const composer = await agentOn(page);
		await makeFileOpensACard(page, composer, 'the agent-auto-mode kill switch is off');
	}
);

// A card nobody answers. The turn ends when the card does: the route's watchdog ends a run that was not
// handed off, and a handed-off run ends when agent-service denies the card at its own 180s timeout. The
// person must be told the run paused at the card: the card says so, the answer says nobody answered in
// time, never "stopped" or "Canceled.", and the turn's one Retry runs it again to the same card.
/** Sends a make-a-file request with Ask before every step on, leaves its approval card unanswered until the
 *  turn ends, and checks the turn reads as paused with exactly one Retry. Returns that Retry. */
async function leaveTheCardUnanswered(page: Page, context: BrowserContext, baseURL: string) {
	await setFlagOverrides(context, baseURL, {
		'agent-mode': true,
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
		turn.getByText('Not answered in time — paused here.').first(),
		'the unanswered card does not say the run paused there'
	).toBeVisible({ timeout: 15_000 });
	await expect(turn.getByText(/— Canceled\./)).toHaveCount(0);
	await expect(turn).toContainText(/Paused: the agent waited for your approval/);
	await expect(turn).not.toContainText('The agent run was stopped before it finished.');
	const retry = turn.getByRole('button', { name: 'Retry', exact: true });
	await expect(retry, 'the paused turn offers no Retry').toHaveCount(1);
	return retry;
}

test(
	'an approval card left unanswered pauses the run there, and the turn offers a Retry that asks again',
	{ tag: ['@preview-only', '@A7', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(480_000);
		const retry = await leaveTheCardUnanswered(page, context, baseURL!);
		await retry.click();
		await expect(
			page.getByText(/Paused: the agent waited for your approval/),
			'Retry on the paused turn did not start it again'
		).toHaveCount(0, { timeout: 30_000 });
	}
);

// Retry on a paused turn runs the request again, so the agent reaches the same step and asks again.
// Its own test, since a second card adds a full run to the paused test's time.
test(
	'Retry on a turn paused at an unanswered approval runs the request again to a new approval card',
	{ tag: ['@preview-only', '@A7', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(720_000);
		const retry = await leaveTheCardUnanswered(page, context, baseURL!);
		// The paused card is resolved and shows no Allow, so an Allow on screen is a new, open card.
		const allow = page.getByRole('button', { name: 'Allow', exact: true });
		await expect(allow).toHaveCount(0);
		await retry.click();
		await expect(
			allow.first(),
			'Retry on the paused turn did not run the request again to a new approval card'
		).toBeVisible({ timeout: 240_000 });
	}
);
