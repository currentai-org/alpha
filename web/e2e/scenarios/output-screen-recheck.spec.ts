// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// The output screen judges each batch of an answer on its own (CUR-3975), so it can cut answers that only
// read as harmful out of context. A flagged batch is asked again with the question and the whole answer
// so far, and released when every rule that fired says no. The re-check runs wherever the output screen
// runs (OUTPUT_MODERATION).
//
// The output_screen_recheck_clears fault flags every batch on chat-block-toxic and answers the re-check
// with a stub "no", so this spec drives the route's wiring, not Shieldstral's scores
// (scripts/output-recheck-calibration.mjs is the live check of those). Without the re-check the same
// flagged batches end in the decline report-a-problem.spec.ts reads under output_screen_blocks. The
// turn's persisted output verdict must say the screen ran and the re-check released a batch, so a
// deployment with the output screen off fails here rather than passing untested. Preview only: the
// fault switch is never armed on production. Tagged @output-screen, so a run where preview does not
// screen output leaves it out (playwright.config.ts).
const PROMPT = 'Reply with exactly one word: PINEAPPLE.';
const DECLINE =
	/declined because it goes against our content policy|withheld by an open content-safety policy/;

test(
	'an answer whose batches the output screen flagged and the re-check cleared arrives whole',
	{ tag: ['@A5', '@preview-only', '@output-screen'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'output_screen_recheck_clears');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await composerHydrated(page);
		await page.getByLabel('Message AI Potluck').fill(PROMPT);
		const conversationId = await sendOpensConversation(page);
		const answer = page.locator('[data-message-role="assistant"]').last();

		await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 60_000 });
		// The verdict the turn persisted, read back once it is written.
		type Verdict = { screened?: boolean; flagged?: boolean; rechecked?: number };
		const verdict = async (): Promise<Verdict | undefined> => {
			const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
			const body = (await res.json()) as {
				json?: { messages?: Array<{ from: string; outputModeration?: Verdict }> };
			};
			return (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)
				?.outputModeration;
		};
		await expect
			.poll(verdict, {
				message:
					'the turn persisted no output-screen verdict: output screening is off on this deployment, or the fault header did not arrive',
				timeout: 15_000
			})
			.toMatchObject({ screened: true, flagged: false });
		expect(
			(await verdict())?.rechecked ?? 0,
			'the re-check released no batch, so the answer below was never flagged and cleared'
		).toBeGreaterThan(0);
		await expect(
			answer.getByText(/PINEAPPLE/),
			'the cleared answer never reached the screen'
		).toBeVisible();
		await expect(
			answer.getByText(DECLINE),
			'a batch the re-check cleared still cut the answer'
		).toHaveCount(0);
	}
);
