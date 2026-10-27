// e2e-product: @chat
// e2e-area: @agent
// One chat turn that needs the web and then code gets both (CUR-4232). With `one-chat-sandbox` on, a native
// turn on Large 3 has the conversation's sandbox (agent-service's /mcp/, no network) beside web search,
// so a question about an event's place and date plus the days until it starts searches, then counts in run_code,
// with no confirmation card. With the flag off the same turn offers no sandbox tool.
//
// @no-replay: the answer depends on a live search and a live sandbox, so a PR's run leaves this out and
// a develop push run walks it live against the shared agent service. Preview-only: production refuses the
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

const PROMPT =
	'Where and when is MozFest 2026? Then work out exactly how many days from today until it starts, using code to count.';

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

async function ask(page: Page): Promise<{ answer: string; trace: string }> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(PROMPT);
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

/** Days from today to 28 October 2026, in both the runner's UTC day and Pacific's, since the prompt's
 *  date line follows the visitor's time zone and the two differ for part of every day. */
function expectedDays(): number[] {
	const start = Date.UTC(2026, 9, 28);
	const dayIn = (tz: string) => {
		const [y, mo, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
			.format(new Date())
			.split('-')
			.map(Number);
		return Math.round((start - Date.UTC(y, mo - 1, d)) / 86_400_000);
	};
	return [...new Set([dayIn('UTC'), dayIn('America/Los_Angeles')])];
}

test(
	'with one-chat-sandbox on, a question needing the web and code searches, then runs code, in one turn with no card',
	{ tag: ['@preview-only', '@no-replay', '@CUR-4232'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'one-chat-sandbox': true });
		await openComposer(page);
		const { answer, trace } = await ask(page);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText(/This turn wants to:/),
			'a sandbox run asked for confirmation'
		).toHaveCount(0);
		expect(trace, 'the turn did not search the web').toContain('Searched for');
		expect(trace, 'the turn did not run code in the sandbox').toContain(
			'run_code on sandbox: it ran'
		);
		expect(trace, 'the trace does not show what the code printed').toContain('stdout:');
		expect(answer, 'the answer does not name where MozFest is').toMatch(/Barcelona/i);
		const days = expectedDays();
		expect(
			days.some((n) => new RegExp(`\\b${n}\\s*days?\\b`, 'i').test(answer)),
			`the answer does not give ${days.join(' or ')} days`
		).toBe(true);
	}
);

test(
	'with one-chat-sandbox off, the same turn offers no sandbox tool',
	{ tag: ['@preview-only', '@no-replay', '@CUR-4232'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'one-chat-sandbox': false });
		await openComposer(page);
		const { trace } = await ask(page);
		expect(trace, 'a sandbox tool ran with the flag off').not.toContain('on sandbox');
	}
);
