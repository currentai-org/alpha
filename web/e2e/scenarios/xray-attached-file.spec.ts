// e2e-product: @chat
// e2e-area: @provenance
import { randomBytes } from 'node:crypto';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { openXrayTab } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

// A visitor attached a file and asked about it, and X-ray's "This answer" said nothing was
// looked up, though the answer was read from that file (CUR-4150). The file the question carried is something
// the answer read, so X-ray names it under "Looked up".
test(
	'an answer to a question with a file attached names that file in X-ray, never "nothing was looked up"',
	{ tag: ['@preview-only', '@CUR-4150', '@CUR-4353'] },
	async ({ page }) => {
		// One real turn, waited on for up to 120s, after up to 60s of setup.
		test.setTimeout(240_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		const name = `lakeside-notes-${randomBytes(4).toString('hex')}.txt`;
		const notes =
			'Lakeside cleanup, Saturday.\nBring gloves and bags.\nMeet at the boathouse at 9.\n';
		await expect(async () => {
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(notes) });
			await expect(page.getByText(name).first()).toBeVisible({ timeout: 5_000 });
		}).toPass({ timeout: 45_000 });
		await composer.fill('Where do we meet, according to these notes?');
		await composer.press('Enter');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer), 'the turn with the file attached did not finish').toBeVisible({
			timeout: 120_000
		});

		await openXrayTab(page, answer, 'This answer', {
			disclosure: { timeout: 15_000 },
			tab: { timeout: 15_000 }
		});
		const receipt = page.locator('[data-answer-receipt]');
		await expect(receipt, 'X-ray does not name the file the question carried').toContainText(
			`Read the file you attached: ${name}.`,
			{ timeout: 15_000 }
		);
		await expect(
			receipt,
			'X-ray says nothing was looked up for an answer read from an attached file'
		).not.toContainText(/nothing was looked up/i);

		// Step by step's "Wrote the answer" said the answer came from training alone (CUR-4353).
		await page.getByRole('tab', { name: 'Step by step' }).click();
		const write = page.locator('[data-xray-steps] [data-step-id="write"]');
		await expect(
			write,
			'Step by step does not say the answer worked from the attached file'
		).toContainText(`It worked from the file you attached: ${name}.`, { timeout: 15_000 });
		await expect(
			write,
			'Step by step says nothing was looked up for an answer read from an attached file'
		).not.toContainText(/nothing was looked up/i);
	}
);
