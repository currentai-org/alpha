// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { installModelReplay } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// When a turn ends the page swaps its own copy of the conversation for the server's. The
// two copies used to give the new messages different ids, and the message list is keyed by id, so
// the swap remounted the answer: a trace or source list the person had just opened snapped shut. The
// linked-page spec in bring-your-own-text.spec.ts failed on exactly that, found the source link, then
// lost it. The page now sends the ids it minted and the server uses them.

async function openChat(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	// The trace opens from the footer's model name, which a canned reply has none of (CUR-2954).
	await installModelReplay(page);
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

test(
	"the server keeps the answer's id, so a trace opened as the answer finishes stays open",
	{ tag: '@CUR-2098' },
	async ({ page }) => {
		await openChat(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one sentence, what is a haiku?');
		await composer.press('Enter');

		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const convId = new URL(page.url()).pathname.split('/').at(-1)!;
		const answer = page.locator('[data-message-role="assistant"]').last();
		// Read the id the moment the answer appears, while it is still the page's own. Read after the
		// answer finishes, it may already be the server's, and the two would trivially match.
		await answer.waitFor({ state: 'attached', timeout: 30_000 });
		const pageId = await answer.getAttribute('data-message-id');
		expect(pageId, 'the answer carries no data-message-id').toBeTruthy();
		await expect(
			answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'no finished answer' + warmupContext()
		).toBeVisible({
			timeout: 60_000
		});

		const trace = answer.getByRole('button', { name: /How this answer was made/ });
		await trace.click();
		await expect(trace).toHaveAttribute('aria-expanded', 'true');

		// The contract: the server stored the answer under the id the page gave it. With two different
		// ids the page's post-turn swap remounts the answer, which is what closed the trace.
		await expect
			.poll(
				async () => {
					const res = await page.request.get(`/chat/api/conversation/${convId}`);
					if (!res.ok()) return `HTTP ${res.status()}`;
					const conv = (await res.json()) as { messages: { id: string; from: string }[] };
					return conv.messages.filter((m) => m.from === 'assistant').at(-1)?.id;
				},
				{ message: "the server's answer id differs from the page's", timeout: 20_000 }
			)
			.toBe(pageId);

		// And what a person sees: the same answer is still on the page, and the trace they opened is still
		// open. `trace` re-resolves against the newest answer, so a remount would read as collapsed here.
		await expect(page.locator(`[data-message-id="${pageId}"]`)).toHaveCount(1);
		await expect(trace).toHaveAttribute('aria-expanded', 'true');
	}
);
