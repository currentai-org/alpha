// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL, MEDIUM_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { composerHydrated, sendOpensConversation } from './helpers/composer';

// The footprint panel's energy and water for an answer come from the server (EcoLogits, priced from
// the provider's own token count), not from a guess at the text's length. A model with no size on
// record is labelled "not estimated" rather than given a stand-in number.

async function answerThenOpenFootprint(page: Page, modelId: string) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await page.goto(pinnedChatEntry(modelId), { waitUntil: 'commit' });
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').fill('Name the capital of Japan in one sentence.');
	await sendOpensConversation(page);
	const message = page.locator('[data-message-role="assistant"]').first();
	await expect(turnDone(message), `the turn on ${modelId} never finished`).toBeVisible({
		timeout: 90_000
	});
	await page.locator('[data-footprint-trigger]:visible').first().click();
}

test(
	'after a Mistral Medium answer the footprint panel shows a server energy range and a water figure, not the text-length guess',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await answerThenOpenFootprint(page, MEDIUM_MODEL);

		// The server's figure arrives after the answer, so the range appears a moment later. The guess
		// shows no range and no water, so this text can only come from the server.
		const range = page.locator('[data-footprint-energy-range]:visible').first();
		await expect(range, 'the panel shows no server energy range').toHaveText(
			/\d+(\.\d+)? ?m?Wh to \d+(\.\d+)? ?m?Wh/,
			{ timeout: 30_000 }
		);
		const water = page.locator('[data-footprint-water-value]:visible').first();
		await expect(water, 'the panel shows no water figure').toHaveText(/^\s*[<\d][\d.]* ?m?L\s*$/);
	}
);

test(
	'after a Mistral Large 4 answer the footprint panel says the energy and water are not estimated',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await answerThenOpenFootprint(page, LARGE4_MODEL);

		const water = page.locator('[data-footprint-water-value]:visible').first();
		await expect(water, 'a model with no size on record got a water figure').toHaveText(
			/not estimated/i,
			{ timeout: 30_000 }
		);
		// The unpriced note and the "not estimated" water line both come from the turn's footprint update,
		// which lands after the answer; wait for it as long as the water line above.
		await expect(
			page.locator('[data-footprint-unpriced]:visible').first(),
			'the panel counts no unpriced answer after a model with no size on record'
		).toBeVisible({ timeout: 30_000 });
	}
);
