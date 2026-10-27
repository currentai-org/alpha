// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// Output screening's deadline is an idle bound, the longest the screen may go without
// releasing a batch, not a cap on the whole answer (CUR-1884). As a whole-answer cap it cut nine healthy prod
// answers in one week that were slow only because the model was.
//
// A real deployment can't show this at the real 25s window: answers stop at the output token cap
// well before 25s. The `output_screen_window_short` fault leaves generation alone and shortens the
// window to one Coop call's own timeout for this one request. The window is measured from the first
// token, so the first release still has to land inside it; after that, a whole-answer cap would cut
// the answer within one window of its first visible text, and an idle bound lets it stream on. So the
// check is how long the answer keeps streaming after its first text appears.
// The window was a fixed 5s until CUR-2705: shorter than one screening call may take, so a slow but
// healthy screen tripped it on 68 of 691 preview turns and the spec failed on PRs that touched no chat.
// Preview-only: the fault switch is never armed on production (faultInjection.ts), and it needs
// output screening on (OUTPUT_MODERATION), so it is tagged @output-screen.
// COOP_TIMEOUT_MS's default, which preview leaves unset (moderation.ts).
const WINDOW_MS = 8_000;
// Copy from screenStream.ts: the truncate notice (a cleared prefix, then the window ran out) and the
// decline (the window ran out before the first release).
const TRUNCATED = "The rest of this response couldn't be verified in time";
const NO_FIRST_RELEASE = "I started to answer, but couldn't finish verifying";

test(
	'a slow but healthy answer that outlasts the screening window streams to the end',
	{ tag: ['@A5', '@preview-only', '@output-screen'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'output_screen_window_short');
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			`Printing press ${Date.now()}: write a detailed guide to the history of the printing press, ` +
				'from its East Asian precursors through Gutenberg to its effects on science and literacy. ' +
				'Use several headed sections and at least ten paragraphs.'
		);
		const sent = page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/conversation\/[a-f0-9]+$/.test(new URL(res.url()).pathname),
			{ timeout: 60_000 }
		);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		// Without this, a deployment that ignored the fault would run the real 25s window, and an answer
		// shorter than 25s would pass for the wrong reason.
		expect(
			(await sent).headers()['x-fault-injected'],
			'the server did not apply output_screen_window_short (wrong or missing E2E_FAULT_INJECT_TOKEN, or not a preview), so this turn ran the real 25s window'
		).toBe('output_screen_window_short');

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(reply, 'no answer text appeared' + warmupContext()).toHaveText(/\w{3,}/, {
			timeout: 60_000
		});
		const firstTextAt = Date.now();
		await expect(
			reply.getByRole('button', { name: 'Retry' }),
			'the long answer never finished' + warmupContext()
		).toBeVisible({ timeout: 120_000 });
		const streamedMs = Date.now() - firstTextAt;
		const text = (await reply.innerText()).trim();

		expect(
			text,
			`the first screened batch did not land inside the ${WINDOW_MS}ms window, so this run could not test what happens after it (a slow model or screen, not the idle bound)`
		).not.toContain(NO_FIRST_RELEASE);
		expect(
			text,
			'the answer was cut with the withheld notice after it started streaming'
		).not.toContain(TRUNCATED);
		// Under a whole-answer cap the stream stops within one window of its first text. Two seconds
		// more leaves margin for the page's own render delay; two whole windows would ask for 16s of
		// streaming, and a tenth of healthy answers on preview stream for less (CUR-2705).
		expect(
			streamedMs,
			`the answer finished ${streamedMs}ms after its first text, inside ${WINDOW_MS + 2_000}ms, so it did not outlast the window and this run proves nothing either way`
		).toBeGreaterThan(WINDOW_MS + 2_000);
		expect(
			text.length,
			'the answer is short for a ten-paragraph guide, so it was cut rather than finished'
		).toBeGreaterThan(2_000);
	}
);
