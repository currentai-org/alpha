// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import sharp from 'sharp';
import { answerShapeEntry } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// The scroll-to-bottom button floats over the answer while the reader is scrolled up (CUR-1630). It sat
// in the fade above the composer, but the fade is only a quarter opaque at the button's height, so
// the button hid words that were still readable ("pressed onto [button]").
// The contract: at the button's height the answer is fully covered, so the button hides nothing a
// reader could still read. Checked on pixels, because only the rendered result says whether text shows.

// The gallery's own desktop window. The button is desktop-only (max-md:hidden).
test.use({ viewport: { width: 1280, height: 720 } });

test(
	'the scroll-to-bottom button sits over a fully covered strip, never over readable answer text',
	{ tag: ['@A5', '@CUR-1630'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			'In eight plain paragraphs of about five sentences each, describe how woodblock printing worked.'
		);
		await composer.press('Enter');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'no finished answer' + warmupContext()
		).toBeVisible({
			timeout: 90_000
		});

		// Scroll back to the top of the conversation, the position a reader is in when the button shows.
		await page.evaluate(() => window.scrollTo({ top: 0 }));
		// Scroll with the wheel, as a reader does: the button updates only on a scroll event.
		const box = (await answer.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + 40);
		await page.mouse.wheel(0, 300);
		await page.mouse.wheel(0, -3000);
		const button = page.getByRole('button', { name: 'Jump to bottom' });
		await expect(button, 'the answer did not overflow enough to show the button').toBeVisible();
		// Let the button's fade-in and the cover's own transition settle before reading pixels.
		await page.waitForTimeout(500);

		const btn = (await button.boundingBox())!;
		const col = (await answer.boundingBox())!;
		// Sample the answer column to the left of the button, at exactly the button's height.
		const clip = {
			x: Math.round(col.x + 8),
			y: Math.round(btn.y),
			width: Math.round(btn.x - 8 - (col.x + 8)),
			height: Math.round(btn.height)
		};
		expect(
			clip.width,
			'the answer column is too narrow to sample beside the button'
		).toBeGreaterThan(100);

		const { channels } = await sharp(await page.screenshot({ clip })).stats();
		const maxStdev = Math.max(...channels.slice(0, 3).map((c) => c.stdev));
		// A strip of uniform background reads ~0; a line of glyphs in it reads well above 10.
		expect(
			maxStdev,
			`answer text is readable at the scroll button's height (pixel stdev ${maxStdev.toFixed(1)})`
		).toBeLessThan(3);

		// Chromium takes that clipped screenshot by resizing the page for a moment, and the recording
		// keeps the resulting frame (the whole page as a thumbnail in the corner, grey around it) until
		// something repaints. Ending the test there left the gallery's A5 clip on a grey screen that
		// read as a crash (CUR-2452). Pressing the button does what a reader would next, and repaints.
		await button.click();
		await expect(button, 'the button stayed up after jumping to the bottom').toBeHidden();
	}
);
