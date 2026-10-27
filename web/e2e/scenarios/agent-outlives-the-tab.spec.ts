// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Locator, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// An agent run keeps going on agent-service after our route stops waiting for it. Closing
// the tab does not do that: the server keeps reading the run and stores it finished. What does is the
// route's generation watchdog, which gives up on a long run and stores the answer interrupted while
// agent-service carries on. `agent_turn_deadline_20s` shortens that watchdog for the first turn only
// (the header is scoped to that page), so a run of ordinary length outlives it. Opening the
// conversation again must bring the same answer back finished: rewritten in place from the task's
// events, with its trace, not regenerated as a sibling.
//
// The stored conversation is read before coming back, so a pass can't come from a run that finished
// inside the deadline: the answer has to be on record as interrupted, holding its task, without the
// receipt. The nonce in the prompt keeps a cached or invented answer from passing.
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

type Returned = {
	back: Page;
	returned: Locator;
	conversationId: string;
	interrupted: StoredMessage;
	nonce: string;
	/** Set when the receipt, once on screen, was gone at a later sample: when, and what showed instead. */
	lostAfterShown?: string;
};

// Runs a turn past its deadline, checks it is stored interrupted, reopens the conversation and waits
// until the screen shows the receipt and the stored answer is finished. The screen is sampled the
// whole time, from the first sign of the receipt to 15s after the stored answer finished, because a
// re-attached answer that vanishes is usually back by the time the stored copy finishes, so a
// single read at the end can pass over a defect (CUR-3875). Both tests below share it, so
// the stored-answer checks keep their own test, which no known-broken cell covers.
async function runPastTheDeadlineAndReturn(
	page: Page,
	context: BrowserContext,
	baseURL: string
): Promise<Returned> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// `agent-run-handoff` off: the run is left for a reload to pick up, which is what this spec measures.
	await setFlagOverrides(context, baseURL, { 'agent-mode': true, 'agent-run-handoff': false });
	await signInAsFreshUser(page);

	const composer = page.getByLabel('Message AI Potluck');
	await installFaultInjectionHeader(page, 'agent_turn_deadline_20s');

	// The develop agent app runs AGENT_MAX_CONCURRENCY (4) runs at once for every shard and PR preview,
	// and refuses the rest with a 429 the route stores as "The agent is at capacity". No run exists
	// then, so the refusal says nothing about the deadline under test. Send again in a new
	// conversation, up to four times, and annotate each refusal so a run that needed one says so.
	const refusedAtCapacity = 'The agent is at capacity right now';
	const reader = await context.newPage();
	let nonce = '';
	let conversationId = '';
	for (let attempt = 1; ; attempt++) {
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await composer.click({ timeout: 30_000 });
		await expect(
			toolsButton(page),
			'the agent control is not offered for a minted @example.org account (`agent-mode-access`, CUR-1611)'
		).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });
		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'On').click();
		await page.keyboard.press('Escape');

		// No files and no code, so the run raises no approval card while nobody is there to answer it.
		nonce = randomBytes(6).toString('hex');
		await composer.fill(
			`Write ten paragraphs on why shared community meals work, each about a different reason. Whether or not you also save them to a file, end your reply in this chat with the exact line: receipt ${nonce}`
		);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		let refused = false;
		await expect
			.poll(
				async () => {
					const last = (await storedAnswers(reader, conversationId)).at(-1);
					refused = (last?.content ?? '').includes(refusedAtCapacity);
					return refused || last?.interrupted === true;
				},
				{
					message:
						'the turn deadline never left the answer stored as interrupted. If it is stored finished, the run beat the 20s deadline and this spec measured nothing',
					timeout: 90_000
				}
			)
			.toBe(true);
		if (!refused) break;
		test.info().annotations.push({
			type: 'agent-capacity',
			description: `attempt ${attempt}: the agent app refused the run at capacity`
		});
		expect(attempt, 'the agent app refused the run at capacity on all four attempts').toBeLessThan(
			4
		);
	}
	const [interrupted] = await storedAnswers(reader, conversationId);
	expect(
		interrupted?.agentRun?.taskId,
		'the interrupted answer holds no agent task, so coming back has nothing to re-attach to'
	).toBeTruthy();
	expect(
		interrupted?.content ?? '',
		'the run had already finished when the deadline fired'
	).not.toContain(`receipt ${nonce}`);
	await page.close();

	const back = reader;
	// The server can keep screening the replay for minutes after a re-attach ends. Record how each
	// attach ended, so a red run says whether the page or the server closed it (CUR-3875).
	const attachPost = (r: { method(): string; url(): string }) =>
		r.method() === 'POST' && r.url().endsWith(`/conversation/${conversationId}`);
	const note = (description: string) =>
		test.info().annotations.push({
			type: 'attach',
			description: `${new Date().toISOString()} ${description}`
		});
	back.on('requestfinished', (r) => attachPost(r) && note('attach POST finished'));
	back.on(
		'requestfailed',
		(r) => attachPost(r) && note(`attach POST failed: ${r.failure()?.errorText}`)
	);
	back.on('console', (m) => m.type() === 'error' && note(`console: ${m.text().slice(0, 200)}`));
	await back.addLocatorHandler(back.getByRole('dialog', { name: 'Welcome to Alpha' }), async () => {
		await back.getByRole('button', { name: /start chatting/i }).click();
	});
	await back.goto(`/chat/conversation/${conversationId}`, { waitUntil: 'commit' });
	// The agent may save the essay to a file, and each write raises a "This turn wants to" card that
	// times out to Deny. Approve them as the person who asked would, the way
	// agent-file-download.spec.ts does, until the receipt arrives.
	const returned = back.locator('[data-message-role="assistant"]').last();
	const allow = back.getByRole('button', { name: 'Allow', exact: true }).first();
	let shownAt: number | undefined;
	let lostAfterShown: string | undefined;
	const sample = async (): Promise<boolean> => {
		const text = (await returned.textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
		const has = text.includes(`receipt ${nonce}`);
		if (has && shownAt === undefined) shownAt = Date.now();
		if (!has && shownAt !== undefined && lostAfterShown === undefined) {
			const after = Math.round((Date.now() - shownAt) / 1000);
			lostAfterShown = `${after}s after it was shown, the answer read: ${text.trim().slice(0, 160)}`;
		}
		return has;
	};
	await expect
		.poll(
			async () => {
				if (await allow.isVisible()) await allow.click();
				return sample();
			},
			{
				message: 'coming back did not re-attach and finish the run',
				timeout: 240_000,
				intervals: [1_000]
			}
		)
		.toBe(true);

	// The page shows the receipt while the output screen is still clearing the rest of the reply, and
	// the interrupted banner's Retry is on screen the whole time, so neither says the turn is over.
	// The stored answer does, and it can be empty while the screen is still clearing.
	await expect
		.poll(
			async () => {
				await sample();
				const [answer] = await storedAnswers(back, conversationId);
				return !answer?.interrupted && (answer?.content ?? '').includes(`receipt ${nonce}`);
			},
			{
				message: 'the re-attached answer was never stored finished with the receipt',
				timeout: 180_000,
				intervals: [2_000]
			}
		)
		.toBe(true);
	const finishedAt = Date.now();
	await expect
		.poll(async () => (await sample(), Date.now() - finishedAt >= 15_000), {
			message: 'the screen could not be watched after the answer was stored finished',
			timeout: 60_000,
			intervals: [1_000]
		})
		.toBe(true);
	return { back, returned, conversationId, interrupted: interrupted!, nonce, lostAfterShown };
}

test(
	'an agent run that outlives its turn deadline comes back finished in place when the conversation is opened again',
	{ tag: ['@preview-only', '@CUR-993'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const { back, conversationId, interrupted, nonce } = await runPastTheDeadlineAndReturn(
			page,
			context,
			baseURL!
		);

		const after = await storedAnswers(back, conversationId);
		expect(
			after.map((m) => m.id),
			're-attaching added an answer instead of rewriting the interrupted one'
		).toEqual([interrupted.id]);
		expect(after[0]).toMatchObject({
			interrupted: false,
			agentRun: { taskId: interrupted.agentRun!.taskId }
		});
		expect(after[0].content).toContain(`receipt ${nonce}`);
	}
);

// Its own test, so the stored-answer checks above go red on their own when this one does (CUR-3875).
test(
	'a re-attached agent answer stays on screen once it is stored finished',
	{ tag: ['@preview-only', '@CUR-3875'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		const { returned, nonce, lostAfterShown } = await runPastTheDeadlineAndReturn(
			page,
			context,
			baseURL!
		);

		// The answer showed, then was lost to a fresh "Working on it…" while the stored copy finished.
		expect(lostAfterShown, 'the re-attached answer left the screen once shown').toBeUndefined();
		await expect(returned, 'the re-attached answer is not on screen at the end').toContainText(
			`receipt ${nonce}`,
			{ timeout: 10_000 }
		);
		await expect(
			returned.locator('[data-exclude-from-copy]').first(),
			'the answer came back without the agent trace'
		).toBeVisible({ timeout: 30_000 });
	}
);
