// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { pinnedChatEntry } from './helpers/servedModel';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { startChattingPastWelcome } from './helpers/welcome';

// A tool round after the first goes out after the lane has committed, so a 429 there used to
// end the turn on "is busy right now" with no retry (CUR-2432). It now retries on the same lane. The `tool_round_rate_limited` fault refuses the first
// request after round 1 once. An arithmetic question, because calculate is the tool that forces a
// round 2. Preview-only: the fault switch is never armed on production.
const LARGE4 = LARGE4_MODEL;
test(
	'a Large 4 tool round refused as over-cap is retried on the same lane and the turn answers',
	{ tag: ['@F2', '@preview-only', '@CUR-2432'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const databaseUrl = process.env.SCENARIO_DATABASE_URL;
		if (!databaseUrl)
			throw new Error('SCENARIO_DATABASE_URL is not set — global-setup.ts should have caught this');
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await signInWithEmailOtp(page, databaseUrl, freshTestEmail());
		await installFaultInjectionHeader(page, 'tool_round_rate_limited');
		await page.goto(pinnedChatEntry(LARGE4), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		// An Enter on the server-rendered box, before the app takes it over, may be dropped (CUR-3345).
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			`3 workshops of 14 people at 18 euros each. What is the total cost? (run ${Date.now()})`
		);
		const conversationId = await sendOpensConversation(page, { timeout: 30_000 });

		await journeyStep(page, 'F2', 3, async () => {
			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(
				reply.getByRole('button', { name: 'Retry' }),
				'the turn never finished' + warmupContext()
			).toBeVisible({ timeout: 120_000 });
			await expect(
				reply,
				'the refused round ended the turn instead of being retried'
			).not.toContainText('is busy right now');
		});

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{
					from: string;
					content?: string;
					routerMetadata?: { model?: string };
					failover?: unknown;
					calculations?: Array<{ expression: string; result?: string }>;
				}>;
			};
		};
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		// Without a calculate call there is no round 2, the fault never fires, and a green would prove
		// nothing, so the call is part of the contract.
		expect(
			answer?.calculations?.length ?? 0,
			'the model answered without calling calculate, so no second round went out and the fault never fired'
		).toBeGreaterThan(0);
		expect(answer?.content ?? '', 'the answer does not state the total').toMatch(/756/);
		// The contract is "the lane that committed is the lane that finished". Which lane commits is not
		// this spec's to control: Large 3 runs on a 30-request-a-minute account the whole suite shares, so
		// a real 429 on the first request moves the turn to the backup before any tool round, by design
		// (CUR-2346), and the fault then fires on the backup's round 2 instead.
		const committed = answer?.failover?.to ?? LARGE4;
		const served = answer?.routerMetadata?.model ?? '';
		if (!answer?.failover) {
			// The direct lane reports the served id, which can carry a dated suffix beyond the pinned one.
			expect(served, 'the turn committed to Large 4 but finished on another model').toMatch(
				/mistral-large/i
			);
		} else {
			expect(answer.failover.from, 'the turn failed over from a model it was not pinned to').toBe(
				LARGE4
			);
			test.info().annotations.push({
				type: 'first-request-429',
				description: `Large 4 refused the first request, so the turn committed to ${committed} and the retry was exercised there`
			});
			expect(
				served,
				'the turn finished on a different model from the one it committed to, so a refused round moved lanes'
			).toBe(committed);
		}
	}
);
