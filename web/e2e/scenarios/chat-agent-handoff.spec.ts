// e2e-product: @chat
// e2e-area: @agent
// Chat hands a long task to the agent. With `one-chat-sandbox` and `chat-agent-handoff` on, a
// native turn asked to hand a multi-file task off shows a card first; on Allow the agent runs in the
// conversation's workdir, and a follow-up turn's sandbox lists the files it wrote. With the handoff flag
// off the same turn shows no handoff card.
//
// @no-replay: the answer depends on a live model and the live agent pair, so a PR's run leaves this out
// and develop's push run walks it against develop's agent pair. Preview-only: production refuses the
// override.
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated } from './helpers/composer';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { openStepByStep } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

const TASK =
	'Hand this to the agent: create a Python package named shapes with circle.py and square.py, each defining an area function, plus test_shapes.py with a test for each, then run the tests.';
const CARD = /This turn wants to: hand this task to the agent/;

async function openComposer(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// The sandbox and the handoff are for signed-in accounts; a guest is offered neither.
	await signInAsFreshUser(page);
	await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

async function send(page: Page, text: string) {
	const composer = page.getByLabel('Message AI Potluck');
	const replies = page.locator('[data-message-role="assistant"]');
	const before = await replies.count();
	await composer.fill(text);
	await composer.press('Enter');
	// The new reply, never the previous turn's finished one.
	await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
	return replies.nth(before);
}

async function traceOf(page: Page, reply: ReturnType<Page['locator']>): Promise<string> {
	await openStepByStep(page, reply, { disclosure: { timeout: 30_000 }, tab: { timeout: 10_000 } });
	const steps = page.locator('[data-xray-steps]');
	await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
	const trace = await steps.innerText();
	await page.keyboard.press('Escape');
	return trace;
}

test(
	'with chat-agent-handoff on, a handed-off task waits for Allow, then the agent writes its files into the same workspace chat reads',
	{ tag: ['@preview-only', '@no-replay', '@CUR-4388'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(420_000);
		await setFlagOverrides(context, baseURL!, {
			'one-chat-sandbox': true,
			'chat-agent-handoff': true
		});
		await openComposer(page);
		const reply = await send(page, TASK);
		await expect(reply.getByText(CARD), 'the handoff ran without asking').toBeVisible({
			timeout: 90_000
		});
		await reply.getByRole('button', { name: 'Allow' }).click();
		await expect(reply.getByText(/hand this task to the agent — Allowed\./)).toBeVisible({
			timeout: 15_000
		});
		await expect(turnDone(reply), 'the turn never finished after Allow').toBeVisible({
			timeout: 240_000
		});
		expect(await traceOf(page, reply), 'the agent was never started').toContain(
			'hand_off_to_agent on agent'
		);

		// The agent's files are in the workdir chat's sandbox reads: a follow-up lists them.
		const followUp = await send(
			page,
			'Use sandbox__list_files to list the files in the workspace now, and name every .py file.'
		);
		await expect(turnDone(followUp), 'the follow-up never finished').toBeVisible({
			timeout: 150_000
		});
		const listed = (await followUp.locator('.prose').allInnerTexts()).join('\n');
		expect(listed, 'the agent did not write circle.py where chat can see it').toContain(
			'circle.py'
		);
	}
);

test(
	'with chat-agent-handoff off, the same request shows no handoff card',
	{ tag: ['@preview-only', '@no-replay', '@CUR-4388'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'one-chat-sandbox': true,
			'chat-agent-handoff': false
		});
		await openComposer(page);
		const reply = await send(page, TASK);
		await expect(turnDone(reply), 'the turn never finished').toBeVisible({ timeout: 200_000 });
		await expect(reply.getByText(CARD), 'a handoff card showed with the flag off').toHaveCount(0);
		expect(await traceOf(page, reply), 'the handoff ran with the flag off').not.toContain(
			'hand_off_to_agent'
		);
	}
);
