// e2e-product: @chat
// e2e-area: @agent
import { test, expect } from './helpers/test';
import { modelWithoutTools, pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { startChattingPastWelcome } from './helpers/welcome';

// The turn planner ran on agent turns, because the agent model declares no tool support, and
// a ledger then handed the turn to the planner's model. With Agent on, a question with a number to work
// out was answered by Mistral Medium as plain chat, and the agent never ran.
//
// `math-routing` is forced on, and the chat starts on a model without tools, whose plan always carries
// the planner (CUR-4015), so the planner is in play on this preview whatever its rollout; the override
// cookie pins `agent-mode`, already 100% on preview.
// Reachable by a minted `@example.org` account because `agent-mode-access` grants that domain on
// preview (CUR-1611).
//
// `@real-agent` (SOL-212): the answer must be the real product, which only a real agent computes, so
// this is the suite's one live agent smoke. It runs on develop's push run and is left out of PR runs.
test(
	'with Agent on, a question with a number to work out runs the agent rather than the math planner (CUR-3884)',
	{ tag: ['@preview-only', '@A7', '@CUR-3884', '@real-agent'] },
	async ({ page, context, baseURL }) => {
		// An agent turn runs a sandbox and several model rounds, as agent-file-download.spec.ts measures.
		test.setTimeout(300_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'math-routing': true
		});
		await signInAsFreshUser(page);

		await page.goto(pinnedChatEntry((await modelWithoutTools(page.request)).id), {
			waitUntil: 'commit'
		});
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await expect(
			toolsButton(page),
			'the agent control is not offered for a minted @example.org account (CUR-1611)'
		).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });

		// "On", not "Auto": auto lets the router call this plain chat, and then the spec measures the router.
		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'On').click();
		await expect(agentOption(page, 'On')).toHaveAttribute('aria-checked', 'true', {
			timeout: 10_000
		});
		await page.keyboard.press('Escape');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await composer.fill('What is 4,817 multiplied by 263?');
		await composer.press('Enter');

		// The develop agent asks before running code; a person who asked for the sum would allow it.
		const allow = page.getByRole('button', { name: 'Allow', exact: true }).first();
		await expect
			.poll(
				async () => {
					if (await allow.isVisible()) await allow.click();
					return turnDone(answer).isVisible();
				},
				{ message: 'the agent turn did not finish', timeout: 240_000, intervals: [1_000] }
			)
			.toBe(true);

		await expect(answer, 'the agent answered with the wrong product').toContainText(
			/1[,.\s]?266[,.\s]?871/
		);

		// A planned turn stores a `math-route` rung and, when the planner found a sum, the ledger it handed
		// to its own model (+server.ts, `turnRungs.push`). The agent never gets a plan, so neither is here.
		// The progress block is no proof either way: the agent may answer a plain product without running
		// a step.
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`, {
			timeout: 10_000
		});
		expect(res.ok(), `the conversation API answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{
					from: string;
					content?: string;
					rungs?: Array<{ rung: string; outcome?: string }>;
					mathLedger?: unknown;
					agentRun?: { taskId?: string };
				}>;
			};
		};
		const stored = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(
			stored?.content,
			'the conversation stored no assistant answer, so the checks below would pass on nothing'
		).toMatch(/1[,.\s]?266[,.\s]?871/);
		// The positive half: agent-service created a task for this turn (endpointAgent.ts yields its id
		// once the task exists). Without it the two absence checks below would pass on a preview where
		// the planner never runs at all.
		expect(
			stored?.agentRun?.taskId,
			'no agent-service task ran this turn, so the agent did not answer it'
		).toBeTruthy();
		expect(
			stored?.rungs?.find((r) => r.rung === 'math-route'),
			'the turn planner ran on an agent turn (CUR-3884)'
		).toBeUndefined();
		expect(
			stored?.mathLedger,
			"the planner's ledger is on the turn, so its model answered in place of the agent (CUR-3884)"
		).toBeUndefined();

		const work = answer.getByRole('button', { name: /expand|collapse/i }).filter({
			hasText: /\b(Working|Predicted|Did not finish)\b/
		});
		test.info().annotations.push({
			type: 'agent-progress-block',
			description: (await work.isVisible())
				? 'shown'
				: 'none: the agent answered without running a step'
		});
	}
);
