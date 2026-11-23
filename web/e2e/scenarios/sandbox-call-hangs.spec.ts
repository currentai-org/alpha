// e2e-product: @chat
// e2e-area: @agent
// A sandbox that stops answering ends the turn with an answer, not "took too long". The
// sandbox is the in-process stand-in that `sandbox_call_hangs` puts in place of agent-service's /mcp/
// (web/src/lib/chat/server/mcp/sandboxWaitStub.ts): it lists run_code and never answers a call. The
// turn's own budget (45 s cap, minus the answer's margin) must end the call; the code step then shows the
// timed-out copy and the model answers around it. A preview cannot make develop's E2B host go silent on
// demand, so only the silence is stood in. Entered on Large 4, which calls tools natively. Preview-only:
// production refuses the fault and the flag override.
//
// The prompt asks for a snippet to be run, not a sum: Large 4 is offered the calculator too, and given
// arithmetic it answers with that instead, so run_code is never called.
import { test, expect } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated } from './helpers/composer';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { openStepByStep } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';
import { ANSWERED_BY_CALCULATOR, CALCULATOR_STEP, RUN_CODE_PROMPT } from './helpers/sandboxStub';

test(
	'a sandbox that never answers ends the turn inside its budget, the code step says it timed out, and an answer follows',
	{ tag: ['@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'one-chat-sandbox': true });
		await installFaultInjectionHeader(page, 'sandbox_call_hangs');
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		// The sandbox is offered to signed-in accounts only.
		await signInAsFreshUser(page);
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
		await composerHydrated(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(RUN_CODE_PROMPT);
		await composer.press('Enter');

		// The turn's cap is 45 s; the hung call is ended before it, so the turn finishes on its own
		// rather than by the watchdog's "took too long".
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(reply),
			'the turn never finished: a hung sandbox call held it past the turn budget'
		).toBeVisible({ timeout: 75_000 });
		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n').trim();
		expect(answer, 'the turn ended with no answer').not.toBe('');
		expect(answer, 'the turn ended on the watchdog message, not an answer').not.toMatch(
			/took too long/i
		);

		await openStepByStep(page, reply, {
			disclosure: { timeout: 30_000 },
			tab: { timeout: 10_000 }
		});
		const steps = page.locator('[data-xray-steps]');
		await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
		const trace = await steps.innerText();
		// After the hung call the model may use the calculator to answer around it; that is fine. A
		// calculator step with no run_code step at all means the sandbox was never asked.
		if (!trace.includes('run_code on sandbox')) {
			await expect(steps.locator(CALCULATOR_STEP), ANSWERED_BY_CALCULATOR).toHaveCount(0);
		}
		expect(trace, 'the code step does not say the run timed out').toContain(
			'run_code on sandbox: it didn’t answer in time'
		);
	}
);
