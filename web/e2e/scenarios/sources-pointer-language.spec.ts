// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// When a grounded answer bails to a hedge, the honesty stream replaces it with a pointer to the
// sources it found (CUR-4339). An Amharic chat got that pointer in English, "I retrieved these sources but didn't
// write an answer from them this time". The `grounded_answer_hedges` fault searches, then hedges with no
// model call, and the route skips the ungrounded re-answer as production does, so the pointer is what
// the visitor reads.
test(
	'an Amharic question whose grounded answer bails gets the sources pointer in Amharic, naming the sources, with no English pointer and no hedge',
	{ tag: ['@preview-only', '@CUR-4339'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'grounded_answer_hedges');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`የጃፓን እና የአውስትራሊያ ዋና ከተሞች ምንድን ናቸው? ${Date.now()}`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByRole('button', { name: 'Retry' }),
			'the turn never finished'
		).toBeVisible({
			timeout: 90_000
		});

		await expect(reply, 'the pointer is not in Amharic').toContainText('እነዚህን ምንጮች አግኝቻለሁ');
		// The search may come back with Amharic pages ("ጃፓን - ውክፔዲያ") or English ones ("Tokyo - Wikipedia"),
		// so the pointer is read for a numbered source with its title, not for one search engine's wording.
		await expect(reply, 'the pointer does not name the sources it found').toContainText(
			/\[1\]\s*\S+/
		);
		await expect(reply, 'the English pointer reached an Amharic chat').not.toContainText(
			'I retrieved'
		);
		await expect(reply, 'the hedge was shown instead of the pointer').not.toContainText(
			'cannot access real-time information'
		);
	}
);
