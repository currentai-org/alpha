// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { defaultModel, pinnedChatEntry } from './helpers/servedModel';
import { installCannedReplies } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// Pressing Enter on the landing screen emptied the composer at ~55 ms, and the message only reappeared
// at ~2.0 s, once POST /conversation and the goto() into it had both finished (CUR-1676).
// CUR-1706 renders the sent message on the landing screen at once.
//
// The create request is held for 3 s here, so the landing screen is still up while the assertion runs:
// a message on screen within that window can only be the optimistic one. Without the hold, a fast
// preview would answer before the check and the spec would pass on the old code too.
//
// Then, after the conversation page takes over, the same words must be on screen exactly once: the
// page also renders the message it was handed through history state, and two bubbles would be the
// regression this fix could cause.
const TEXT = 'What is the capital of Peru?';
const MODEL_PAGE_TEXT = 'What is the capital of Chile?';
const HOLD_MS = 3_000;

async function sendAndCheck(page: Page, entry: string, text: string) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.route(/\/chat\/conversation$/, async (route) => {
		if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, HOLD_MS));
		await route.continue();
	});
	await installCannedReplies(page);

	await page.goto(entry, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	const sent = await journeyStep(page, 'F2', 1, async () => {
		await composer.click({ timeout: 30_000 });
		await composer.fill(text);
		const landing = page.url();
		await composer.press('Enter');

		const sent = page.locator('[data-message-type="user"]', { hasText: text });
		await expect(sent, 'the sent message is not on screen within 300 ms of Enter').toBeVisible({
			timeout: 300
		});
		expect(
			page.url(),
			'the page navigated before the hold ended, so the check above proves nothing'
		).toBe(landing);
		return sent;
	});

	await journeyStep(page, 'F2', 2, () =>
		page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 })
	);

	await journeyStep(page, 'F2', 3, async () => {
		const reply = page.locator('[data-message-role="assistant"]').first();
		await expect(
			turnDone(reply),
			`the first turn never finished within 60s` + warmupContext()
		).toBeVisible({
			timeout: 60_000
		});
		await expect(
			sent,
			'the conversation page shows the first message more or less than once'
		).toHaveCount(1);
	});
}

test(
	'a first message sent from the landing screen stays on screen while the conversation is created, and shows once after',
	{ tag: ['@F2', '@CUR-1676'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await sendAndCheck(page, chatEntry(), TEXT);
	}
);

// A model's own page carries its own copy of the landing's send, and CUR-1706's bubble went
// into the landing only. Under the gallery's prod profile chatEntry() already enters here; this case
// pins the model page so develop's default runs check it too.
test(
	"a first message sent from a model's own page stays on screen while the conversation is created, and shows once after",
	{ tag: ['@F2', '@CUR-2618'] },
	async ({ page, request }) => {
		test.setTimeout(120_000);
		const model = await defaultModel(request);
		await sendAndCheck(page, pinnedChatEntry(model.id), MODEL_PAGE_TEXT);
	}
);
