// e2e-product: @chat
// e2e-area: @composer @turn
import { test, expect, type Page } from './helpers/test';
import sharp from 'sharp';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// With no known-CSAM hash check, the input safety screen is a chat picture's only check, so a picture
// whose sexual-content question goes unanswered is refused as couldn't-check, the way an unanswered
// child-safety question is, while the same unanswered question on text keeps the content rules'
// fail-open. `input_image_sexual_unanswered` swaps the real screen's guard for one that
// leaves `chat-block-sexual` unanswered on pictures only and answers no to everything else
// (faultInjection.ts imageSexualUnansweredJudge). The picture is a plain blue square.

async function bluePng(): Promise<Buffer> {
	return sharp({ create: { width: 64, height: 64, channels: 3, background: '#1040d0' } })
		.png()
		.toBuffer();
}

async function pastePicture(page: Page, name: string): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	const b64 = (await bluePng()).toString('base64');
	await composer.evaluate(
		(el, { b64, name }) => {
			const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([raw], name, { type: 'image/png' }));
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		},
		{ b64, name }
	);
	await expect(
		page.getByAltText(name).or(page.getByText(name)).first(),
		'the composer did not attach the photo, so photo attachments are off here'
	).toBeVisible({ timeout: 10_000 });
}

// `@real-screen`: the fault replaces the real input screen's guard, and a PR preview otherwise stubs
// the whole screen.
test(
	"a picture whose sexual-content check can't answer is declined as couldn't-check, while text under the same check is answered",
	{ tag: ['@preview-only', '@real-screen', '@A6'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'input_image_sexual_unanswered');
		// `multimodal` is team-only on preview, and signInAsFreshUser mints an @example.org team account.
		await signInAsFreshUser(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		// Text alone: the unanswered rule is never asked a picture, so the turn is answered.
		await composer.fill('Reply with the single word: ready.');
		await composer.press('Enter');
		const first = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(first),
			'no finished answer to the text turn' + warmupContext()
		).toBeVisible({
			timeout: 90_000
		});
		await expect(
			first.getByTestId('safety-badge'),
			'the text turn was declined, so the fail-closed reached text'
		).toHaveCount(0);
		await expect(first, 'the text turn finished with no answer').not.toBeEmpty();

		// The same question with a picture: the picture's sexual-content check went unanswered, so the
		// turn is refused before any model call.
		const answers = page.locator('[data-message-role="assistant"]');
		const before = await answers.count();
		await pastePicture(page, 'square.png');
		await composer.fill('Reply with the single word: ready.');
		await composer.press('Enter');
		await expect(answers, 'no reply to the picture turn').toHaveCount(before + 1, {
			timeout: 30_000
		});
		const second = answers.last();
		await expect(
			second.getByTestId('safety-badge'),
			"the picture turn was not declined as couldn't-check, so an unanswered sexual-content check let the picture through"
		).toHaveAttribute('data-unscreened', 'true', { timeout: 120_000 });
	}
);
