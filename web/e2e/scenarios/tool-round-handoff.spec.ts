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

// A tool round after the first goes out after the lane has committed (CUR-2307). When Large 3's account
// stays over its cap through that round's same-lane retries, the turn used to end on "is busy right now"
// (always after a tool call and before any answer text).
// A backup lane to Mistral Medium continued it until CUR-4383 removed every lane to another model, so
// the turn ends on the busy notice again, naming Large 4, and nothing else answers in its name.
// `tool_round_rate_limited_sustained` refuses every request after round 1 on the first lane. Signed in
// and arithmetic for the same reasons as tool-round-retry.spec.ts.
const LARGE4 = LARGE4_MODEL;
test(
	'a Large 4 tool round that stays over-cap ends on the busy notice naming Large 4, never answered by Mistral Medium (CUR-4383)',
	{ tag: ['@F2', '@preview-only', '@CUR-4383'] },
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
		await installFaultInjectionHeader(page, 'tool_round_rate_limited_sustained');
		await page.goto(pinnedChatEntry(LARGE4), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composerHydrated(page);
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			`3 workshops of 14 people at 18 euros each. What is the total cost? (run ${Date.now()})`
		);
		const conversationId = await sendOpensConversation(page, { timeout: 30_000 });

		await journeyStep(page, 'F2', 3, async () => {
			const reply = page.locator('[data-message-role="assistant"]').last();
			const busy = reply.getByText(/ is busy right now/);
			await expect(
				busy,
				'the over-cap round did not end on the busy notice; if Medium answered, a lane to another model is back' +
					warmupContext()
			).toBeVisible({ timeout: 120_000 });
			await expect(
				busy,
				'the busy notice names another model than the Large 4 that was picked'
			).toContainText(/Large 4/);
			await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
		});

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{
					from: string;
					content?: string;
					routerMetadata?: { model?: string };
					failover?: { from?: string; to?: string; cause?: string };
					calculations?: Array<{ expression: string; result?: string }>;
				}>;
			};
		};
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Large 4`
		).toBeUndefined();
		expect(
			answer?.routerMetadata?.model ?? '',
			'the stored turn names Mistral Medium as the model that answered'
		).not.toMatch(/mistral-medium/i);
		// Without a calculate call there is no round 2, the fault never fires, and a green would prove
		// nothing, so the call is part of the contract.
		expect(
			answer?.calculations?.length ?? 0,
			'the model answered without calling calculate, so no second round went out and the fault never fired'
		).toBeGreaterThan(0);
	}
);
