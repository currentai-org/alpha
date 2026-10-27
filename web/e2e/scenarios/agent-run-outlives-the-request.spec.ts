// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// An agent run longer than one chat request finishes on the page that asked for it. The request hands
// the run off before its watchdog (deadlineLadder.ts agentHandoffAt), the answer is stored interrupted
// with the run still open, and the page re-attaches to it until the run ends, with no reload and no
// timeout shown. Before this, a run was cut at the 155s watchdog and the person read "timed out".
//
// `agent_turn_deadline_20s` gives every request from this page a 20s watchdog, and the scenario
// stand-in (fakeAgentService.ts) takes 35s, so the run outlasts at least one request: the page has to
// follow it across requests to show the receipt. The nonce keeps a cached or invented answer from
// passing, and the count of sends proves the page re-attached rather than one request finishing.
//
// Reachable by a signed-in `@example.org` account on preview, as in agent-file-download.spec.ts.

type StoredMessage = {
	id: string;
	from: string;
	content?: string;
	interrupted?: boolean;
	agentRun?: { taskId: string; closed?: boolean };
};

async function storedAnswers(page: Page, conversationId: string): Promise<StoredMessage[]> {
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	const body = (await res.json()) as { json?: { messages?: StoredMessage[] } };
	return (body.json?.messages ?? []).filter((m) => m.from === 'assistant');
}

/** Signs in with the handoff on and a 20s watchdog, sends an agent turn with a nonce, and returns once
 *  the page is on the conversation. `sends` counts every POST to it: the send, then each re-attach. */
async function sendLongAgentTurn(page: Page, context: BrowserContext, baseURL: string) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await setFlagOverrides(context, baseURL, { 'agent-mode': true, 'agent-run-handoff': true });
	await signInAsFreshUser(page);
	await installFaultInjectionHeader(page, 'agent_turn_deadline_20s');

	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await expect(
		toolsButton(page),
		'the agent control is not offered for a minted @example.org account (`agent-mode-access`, CUR-1611)'
	).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });
	await openAgentTools(page, { timeout: 15_000 });
	await agentOption(page, 'On').click();
	await page.keyboard.press('Escape');

	const counter = { sends: 0 };
	page.on('request', (r) => {
		if (r.method() === 'POST' && /\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname))
			counter.sends++;
	});

	const nonce = randomBytes(6).toString('hex');
	await composer.fill(
		`Write ten paragraphs on why shared community meals work, each about a different reason. End your reply in this chat with the exact line: receipt ${nonce}`
	);
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
	return { conversationId, nonce, counter };
}

/** Waits for the receipt on screen, failing on any timeout text shown on the way. */
async function expectReceiptWithoutTimeout(page: Page, nonce: string, message: string) {
	const answer = page.locator('[data-message-role="assistant"]').last();
	let sawTimeout = '';
	await expect
		.poll(
			async () => {
				const text = (await answer.textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
				if (/timed out|ran out of time/i.test(text) && !sawTimeout)
					sawTimeout = text.trim().slice(0, 200);
				return text.includes(`receipt ${nonce}`);
			},
			{ message, timeout: 150_000, intervals: [1_000] }
		)
		.toBe(true);
	expect(sawTimeout, 'the page showed a timeout while the run was still going').toBe('');
}

async function expectStoredFinished(page: Page, conversationId: string, nonce: string) {
	await expect
		.poll(
			async () => {
				const stored = await storedAnswers(page, conversationId);
				return {
					answers: stored.length,
					finished: stored[0]?.interrupted !== true,
					receipt: (stored[0]?.content ?? '').includes(`receipt ${nonce}`)
				};
			},
			{
				message: 'the followed run was never stored as one finished answer with the receipt',
				timeout: 60_000,
				intervals: [2_000]
			}
		)
		.toEqual({ answers: 1, finished: true, receipt: true });
}

test(
	'an agent run longer than its request is followed on the same page to a finished, stored answer',
	{ tag: ['@preview-only', '@CUR-4410', '@CUR-993'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const { conversationId, nonce, counter } = await sendLongAgentTurn(page, context, baseURL!);
		await expectReceiptWithoutTimeout(
			page,
			nonce,
			'the page never showed the run finished: it did not follow the run past its request'
		);
		expect(
			counter.sends,
			'only one request ran, so the run finished inside it and this spec measured nothing'
		).toBeGreaterThanOrEqual(2);
		await expectStoredFinished(page, conversationId, nonce);
	}
);

// A reload while the page is following the run leaves that follow's request running on the server,
// which hands the run off again at its own deadline. The reloaded page has to pick the run up from
// there by itself, not leave "still working" up until the visitor reloads a second time.
test(
	'a reload while the page follows an agent run still ends on the finished answer, with no second reload',
	{ tag: ['@preview-only', '@CUR-4410', '@CUR-993'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const { conversationId, nonce, counter } = await sendLongAgentTurn(page, context, baseURL!);
		await expect
			.poll(() => counter.sends, {
				message: 'the page never re-attached to the run after the first request handed it off',
				timeout: 60_000,
				intervals: [500]
			})
			.toBeGreaterThanOrEqual(2);
		await page.reload({ waitUntil: 'commit' });
		const sendsAtReload = counter.sends;
		await expectReceiptWithoutTimeout(
			page,
			nonce,
			'after one reload mid-follow the page never showed the run finished'
		);
		expect(
			counter.sends,
			'the reloaded page never re-attached, so the receipt came from somewhere else'
		).toBeGreaterThan(sendsAtReload);
		await expectStoredFinished(page, conversationId, nonce);
	}
);
