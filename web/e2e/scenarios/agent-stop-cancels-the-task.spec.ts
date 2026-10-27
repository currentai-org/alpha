// e2e-product: @chat
// e2e-area: @agent
import { randomBytes } from 'node:crypto';
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { startChattingPastWelcome } from './helpers/welcome';

// Stop on an agent turn said "Stopped before any answer arrived", but the task ran on, a
// reload showed "Working on it…", and the task finished and saved the file it was asked to abandon.
// stop-generating built its cancel from the bare registry entry, which failed the endpoint schema, so
// no cancel reached agent-service and the run's handle was never closed for a reload to respect.
//
// The contract: once Stop is pressed, the stored answer holds its task with the handle closed, and
// opening the conversation again after the run would have finished shows the turn still stopped, with
// no file and no "Working on it…". The scenario stand-in (fakeAgentService.ts, SOL-212) finishes a run
// 35s after it starts and writes the file the prompt names, so a reload that re-attaches shows it.
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

/** The stand-in's run length (FAKE_RUN_MS) plus room for the reload, so a re-attached run would end. */
const PAST_THE_RUN_MS = 45_000;

test(
	'Stop on an agent turn cancels its task, and a reload after the run would have ended shows it stopped with no file',
	{ tag: ['@preview-only', '@CUR-4602', '@CUR-993'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-artifact-download': true
		});
		await signInAsFreshUser(page);

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

		const nonce = randomBytes(6).toString('hex');
		const filename = `stopped-${nonce}.txt`;
		await composer.fill(
			`Create a text file named ${filename} whose only content is the line: potluck ${nonce}`
		);
		await composer.press('Enter');
		const sentAt = Date.now();
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		// The run's plan streams a second after the task starts, so the task exists before Stop. The
		// answer itself streams from 26s, so Stop lands before any of it.
		const answer = page.locator('[data-message-role="assistant"]').last();
		// The plan may sit inside the collapsed progress block, so either one showing will do.
		const running = answer
			.getByText('Work out the answer')
			.or(
				answer.getByRole('button', { name: /expand|collapse/i }).filter({ hasText: /\bWorking\b/ })
			)
			.first();
		await expect(
			running,
			'the agent run never showed its plan or progress block, so there was no running task to stop'
		).toBeVisible({ timeout: 60_000 });

		const stop = page.getByRole('button', { name: 'Stop generating' });
		const stopResponse = page.waitForResponse(
			(r) =>
				r.request().method() === 'POST' &&
				r.url().endsWith(`/conversation/${conversationId}/stop-generating`),
			{ timeout: 30_000 }
		);
		await stop.click();
		expect((await stopResponse).status(), 'stop-generating did not answer 200').toBe(200);
		await expect(answer.getByText('Stopped before any answer arrived.')).toBeVisible({
			timeout: 15_000
		});

		// The server side of the stop: the task the turn started is on record, and its handle is closed,
		// which is what a reload reads to decide whether to re-attach (generationState.ts).
		let stopped: StoredMessage | undefined;
		await expect
			.poll(
				async () => {
					stopped = (await storedAnswers(page, conversationId)).at(-1);
					return {
						task: Boolean(stopped?.agentRun?.taskId),
						closed: stopped?.agentRun?.closed === true
					};
				},
				{
					message:
						'the stopped answer never had its agent task closed, so Stop did not cancel it and a reload re-attaches',
					timeout: 30_000,
					intervals: [1_000]
				}
			)
			.toEqual({ task: true, closed: true });

		// Come back once a run that kept going would have finished and saved its file.
		await expect
			.poll(() => Date.now() - sentAt >= PAST_THE_RUN_MS, {
				message: 'the clock never passed the stand-in run length',
				timeout: PAST_THE_RUN_MS + 5_000,
				intervals: [1_000]
			})
			.toBe(true);
		await page.goto(`/chat/conversation/${conversationId}`, { waitUntil: 'commit' });
		const reloaded = page.locator('[data-message-role="assistant"]').last();
		await expect(reloaded.getByText('Stopped before any answer arrived.')).toBeVisible({
			timeout: 30_000
		});

		// Watched for 15s, because a re-attach starts a moment after the page loads.
		const watchedFrom = Date.now();
		let seen = '';
		await expect
			.poll(
				async () => {
					const text = (await reloaded.textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
					if (
						/Working on it|Files this turn produced/.test(text) ||
						text.includes(`potluck ${nonce}`)
					)
						seen = text.trim().slice(0, 200);
					return seen !== '' || Date.now() - watchedFrom >= 15_000;
				},
				{
					message: 'the reloaded turn could not be watched for 15s',
					timeout: 30_000,
					intervals: [1_000]
				}
			)
			.toBe(true);
		expect(seen, 'after the reload the stopped turn re-attached to its task').toBe('');

		const [after] = await storedAnswers(page, conversationId);
		expect(after?.interrupted, 'the stopped answer is no longer stored interrupted').toBe(true);
		expect(
			after?.content ?? '',
			'the stopped answer was stored with the file the run made'
		).not.toContain(filename);
	}
);
