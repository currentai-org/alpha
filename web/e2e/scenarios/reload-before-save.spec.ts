// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// Someone who reloads in the seconds after sending, before the server has saved the
// question, used to get an empty conversation that never filled in, though the server went on to
// save the answer (CUR-1893). A cold instance opens that gap (7s from send to save, seen on a preview); the
// `question_save_delayed` fault opens the same gap on demand.
//
// The stored conversation is read right after the reload, so a pass can't come from a reload that
// landed after the save, where the page would have found the turn in its snapshot anyway.
// Preview-only: the fault switch is never armed on production.
test(
	'reloading before the question is saved still shows the question and its answer, with no second reload',
	{ tag: ['@C3', '@preview-only', '@CUR-1893'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'question_save_delayed');
		await page.goto('/chat', { waitUntil: 'commit' });

		// The same text every run, so a PR replays develop's recording of it: the read below is scoped
		// to this run's new conversation id, which is what keeps it from matching another run's turn.
		const question = 'CUR-1893 reload check: what is the capital of Switzerland?';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		await page.reload({ waitUntil: 'commit' });
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const stored = (await res.json()) as { json?: { messages?: Array<{ content?: string }> } };
		expect(
			(stored.json?.messages ?? []).some((m) => m.content?.includes(question)),
			'the question was already saved when the page reloaded, so this run never opened the gap. If `question_save_delayed` is wired, the reload or the read took longer than the delay'
		).toBe(false);

		await journeyStep(page, 'C3', 6, async () => {
			await expect(
				page.getByText(question),
				'the question never appeared after the reload: the page did not wait for the turn it sent'
			).toBeVisible({ timeout: 60_000 });
			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(turnDone(reply), 'the answer never finished on the reloaded page').toBeVisible({
				timeout: 90_000
			});
			await expect(reply).toContainText(/Bern/i);
		});
	}
);
