// e2e-product: @chat
// e2e-area: @agent
// Run-code in chat has usage tiers (CUR-4578). A new account runs code from its first message, with one
// live sandbox at a time: a run in a second conversation, while the first still holds its sandbox, does
// not run, and the person is told when it frees up and how the allowance grows.
//
// The sandbox is the in-process stand-in that `sandbox_stub` puts in place of agent-service's /mcp/
// (web/src/lib/chat/server/mcp/e2eStub.ts). It carries the real sandbox's server name, so the tier gate
// (mcp/sandboxAllowance.ts) and the run history in chat's database are the real ones; only the box the
// code would run in is stood in, so the spec does not test an E2B host's uptime. Entered on Large 4,
// which calls tools natively. Preview-only: production refuses the fault and the flag override.
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated } from './helpers/composer';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { openStepByStep } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

// What the stand-in's run_code prints (SANDBOX_STUB_STDOUT): 2 to the power 100.
const STUB_STDOUT = '1267650600228229401496703205376';

async function newConversation(page: Page): Promise<void> {
	await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

async function ask(page: Page, prompt: string): Promise<{ answer: string; trace: string }> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(prompt);
	await composer.press('Enter');
	const reply = page.locator('[data-message-role="assistant"]').last();
	await expect(turnDone(reply), 'the turn never finished').toBeVisible({ timeout: 150_000 });
	const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
	await openStepByStep(page, reply, { disclosure: { timeout: 30_000 }, tab: { timeout: 10_000 } });
	const steps = page.locator('[data-xray-steps]');
	await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
	const trace = await steps.innerText();
	await page.keyboard.press('Escape');
	return { answer, trace };
}

test(
	'a new account gets one live sandbox: code runs in one conversation, and a run in a second is refused with when it frees up',
	{ tag: ['@preview-only', '@CUR-4578'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(360_000);
		await setFlagOverrides(context, baseURL!, { 'one-chat-sandbox': true });
		await installFaultInjectionHeader(page, 'sandbox_stub');
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		// A fresh account is on the first tier: one live sandbox.
		await signInAsFreshUser(page);

		await newConversation(page);
		const first = await ask(
			page,
			'Use code to compute 2 to the power of 100 and tell me the exact number.'
		);
		expect(first.trace, 'the first conversation did not run code').toContain(
			'run_code on sandbox: it ran'
		);
		expect(first.trace, 'the trace does not show what the code printed').toContain(STUB_STDOUT);

		// Within the idle window the first conversation still holds the account's one sandbox.
		await newConversation(page);
		const second = await ask(
			page,
			'Run some Python for me: what is 3 to the power of 50, exactly?'
		);
		expect(second.trace, 'the second conversation ran code past the account limit').not.toContain(
			'run_code on sandbox: it ran'
		);
		expect(second.trace, 'the trace does not say the run was past the allowance').toContain(
			'this account is at its code allowance for now'
		);
		expect(second.trace, 'the limit message does not say when it frees up').toMatch(
			/One frees up in \d+ minutes?/
		);
		expect(second.trace, 'the limit message does not say how the allowance grows').toContain(
			'moves up to 2 sandboxes at a time'
		);
		// The answer passes the message on in its own words; no raw error reaches the person.
		expect(second.answer, 'the answer does not tell the person about the limit').toMatch(
			/minute|sandbox|allowance|limit/i
		);
		expect(second.answer).not.toMatch(/Error executing tool|stack trace|Traceback/i);
	}
);
