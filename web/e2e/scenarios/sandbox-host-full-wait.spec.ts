// e2e-product: @chat
// e2e-area: @agent
// A full sandbox host makes the person wait, with a status, instead of failing at once (CUR-4584). A run
// that has to wait for a free slot shows "Waiting for a free sandbox…" on the live line while it waits,
// and then the turn carries on with the run's result.
//
// The sandbox is the in-process stand-in that `sandbox_host_full` puts in place of agent-service's /mcp/
// (web/src/lib/chat/server/mcp/sandboxWaitStub.ts). It answers a run as agent-service does when every
// slot on the E2B host is taken: an SSE reply with one MCP progress notification, then the result after
// eight seconds. The SDK client, the kit's frames, the phase marker and the live line are the real ones;
// only the host being full is stood in, since a preview cannot fill develop's shared E2B host on demand.
// Entered on Large 4, which calls tools natively. Preview-only: production refuses the fault and the
// flag override.
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

// What the stand-in's run_code prints once its wait is over (SANDBOX_WAIT_STUB_STDOUT): 2 to the 43.
const STUB_STDOUT = '8796093022208';

test(
	'a run on a full sandbox host shows "Waiting for a free sandbox…" while it waits, then the run’s result',
	{ tag: ['@preview-only', '@CUR-4584'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'one-chat-sandbox': true });
		await installFaultInjectionHeader(page, 'sandbox_host_full');
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		// The sandbox is offered to signed-in accounts only (CUR-4400).
		await signInAsFreshUser(page);
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
		await composerHydrated(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Use code to compute 2 to the power of 43 and tell me the exact number.');
		await composer.press('Enter');

		// While the run waits for a slot, the live line says so.
		const waiting = page
			.locator('[data-live-line]')
			.filter({ hasText: 'Waiting for a free sandbox' });
		await expect(waiting, 'the live line never said the run was waiting for a sandbox').toBeVisible(
			{
				timeout: 90_000
			}
		);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply), 'the turn never finished after the wait').toBeVisible({
			timeout: 150_000
		});
		// The wait ended with the turn: no line still says it is waiting.
		await expect(waiting).toHaveCount(0);
		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');

		await openStepByStep(page, reply, {
			disclosure: { timeout: 30_000 },
			tab: { timeout: 10_000 }
		});
		const steps = page.locator('[data-xray-steps]');
		await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
		const trace = await steps.innerText();
		expect(trace, 'the run did not go through after its wait').toContain(
			'run_code on sandbox: it ran'
		);
		expect(trace, 'the trace does not show what the code printed').toContain(STUB_STDOUT);
		// The model may group the digits (8,796,093,022,208), so they are read without separators.
		expect(
			answer.replace(/[,\s\u202f\u00a0.]/g, ''),
			'the answer does not give the run’s result'
		).toContain(STUB_STDOUT);
		expect(answer).not.toMatch(/sandbox (is )?busy|host is full|try again/i);
	}
);
