// e2e-product: @chat
// e2e-area: @turn
import { randomUUID } from 'node:crypto';
import { test, expect } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { MOCK_ANSWER_MARK, mockAnswerShown } from './helpers/replayMiss';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// The scenario verdict tells a red a mock answered from a red the PR caused by asking, after a
// failed attempt, whether the page shows a mock answer (helpers/replayMiss.ts) (SOL-250). This proves that question
// says yes on a real preview: the send asks for mock mode itself, on every run (a record run would
// otherwise call the live model), and carries a nonce no recording can match.
test(
	'a turn no recording matches shows the mock answer, and the replay-miss detector sees it on the page',
	{ tag: ['@SOL-250'] },
	async ({ page, context }) => {
		test.setTimeout(120_000);
		const token = process.env.E2E_FAULT_INJECT_TOKEN;
		expect(
			token,
			'E2E_FAULT_INJECT_TOKEN is unset, so the send cannot ask for mock mode'
		).toBeTruthy();
		// A route sees the request after the fixtures' fetch wrappers, so its header is the one sent.
		await page.route(/\/chat\/conversation\/[a-f0-9]+$/, (route) =>
			route.request().method() === 'POST'
				? route.continue({
						headers: {
							...route.request().headers(),
							'x-e2e-fault-inject-token': token!,
							'x-e2e-replay': 'mock'
						}
					})
				: route.continue()
		);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`What rhymes with orange? (${randomUUID()})`);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 100_000 });
		const body = (await answer.locator('.prose').first().innerText()).trim();
		expect(body, `the answer is not the mock: ${body.slice(0, 300)}`).toContain(MOCK_ANSWER_MARK);
		expect(
			await mockAnswerShown(context.pages()),
			'the detector missed a mock answer on the page'
		).toBe(true);
	}
);
