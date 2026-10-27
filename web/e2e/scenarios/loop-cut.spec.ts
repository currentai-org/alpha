// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';

// An answer that starts repeating itself is cut while it streams, before the output screen
// reads it. A looping model once produced about 12,000 characters, and the screen declined
// the whole run as violent. Real loops come up about once in thirty turns, so the `answer_loops` fault
// streams one: a sentence, then "The tide comes in and the tide goes out again." 300 times (CUR-3318).
const LOOP_SPAN = 'The tide comes in and the tide goes out again.';
const NOTICE = 'I got stuck repeating myself';
// The same notice on a French turn (CUR-4052), from repetitionGuard.ts's repetitionNotice('fr').
const NOTICE_FR = 'Je me suis mis à me répéter';

async function askAndReadStored(
	page: Page,
	question = 'Why are there two tides a day?'
): Promise<string> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await installFaultInjectionHeader(page, 'answer_loops');
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(`${question} ${Date.now()}`);
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

	const reply = page.locator('[data-message-role="assistant"]').last();
	await expect(reply.getByRole('button', { name: 'Retry' }), 'the turn never finished').toBeVisible(
		{
			timeout: 90_000
		}
	);
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	const body = (await res.json()) as {
		json?: { messages?: Array<{ from: string; content?: string }> };
	};
	const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
	return answer?.content ?? '';
}

const repeats = (text: string) => text.split(LOOP_SPAN).length - 1;

test(
	'an answer that loops is cut within a few repeats and ends with the repetition notice',
	{ tag: ['@F2', '@preview-only', '@CUR-3318'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const stored = await askAndReadStored(page);
		expect(stored, 'the fault never reached the server: no loop sentence in the answer').toContain(
			LOOP_SPAN
		);
		expect(stored, 'the loop ran on without the repetition notice').toContain(NOTICE);
		expect(
			repeats(stored),
			'the loop cut let the repeated sentence through more than a window of times'
		).toBeLessThan(20);
		await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(NOTICE);
	}
);

// The injury for the test above, run every time: with the cut forced off the same fault streams every
// repeat, so the first test cannot pass because the fault stopped looping.
test(
	'with loop-cut off, the same looping answer streams in full and carries no notice',
	{ tag: ['@F2', '@preview-only', '@CUR-3318'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'loop-cut': false });
		const stored = await askAndReadStored(page);
		expect(stored).not.toContain(NOTICE);
		expect(repeats(stored), 'the fault streamed fewer repeats than it sends').toBeGreaterThan(250);
	}
);

test(
	'a French turn that loops ends with the repetition notice in French, not English',
	{ tag: ['@F2', '@preview-only', '@CUR-4052'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		// The detector reads some plain French as Catalan (a question built on "la" and "de", which its
		// Catalan word list counts and its French one does not), so this one leans on les/est/des.
		// That miss is reported on CUR-1380, the detector's ticket; this spec tests the notice.
		const stored = await askAndReadStored(
			page,
			"Pourquoi est-ce que les marées changent deux fois par jour ? Explique-moi avec des mots simples, s'il te plaît."
		);
		expect(stored, 'the fault never reached the server: no loop sentence in the answer').toContain(
			LOOP_SPAN
		);
		expect(stored, 'the loop notice on a French turn is still in English').not.toContain(NOTICE);
		expect(stored, 'the loop ran on without the French notice').toContain(NOTICE_FR);
		await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(NOTICE_FR);
	}
);
