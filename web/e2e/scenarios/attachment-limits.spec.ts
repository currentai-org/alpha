// e2e-product: @chat
// e2e-area: @composer
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';
import { installCannedReplies } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';

// Chat attachments travel base64-encoded inside the message request, which Vercel caps at
// 4.5 MB, so the composer's limit is a total per message (`$lib/chat/constants/uploadLimits`). These
// drive the composer the way a person attaches, by dropping a file, and read what the composer and the
// error banner say. The numbers mirror CHAT_ATTACHMENTS_MAX_BYTES: a spec imports nothing from src.
const LIMIT_BYTES = 3_000_000;
const REFUSAL = /Attachments can add up to 3\.0 MB per message/;

async function dropText(page: Page, name: string, bytes: number) {
	const dataTransfer = await page.evaluateHandle(
		([fileName, size]) => {
			const dt = new DataTransfer();
			dt.items.add(
				new File(['a'.repeat(size as number)], fileName as string, { type: 'text/plain' })
			);
			return dt;
		},
		[name, bytes] as const
	);
	await page
		.getByRole('form', { name: 'file dropzone' })
		.dispatchEvent('dragenter', { dataTransfer });
	const dropzone = page.getByText('Drop files to attach');
	await expect(dropzone).toBeVisible({ timeout: 10_000 });
	await dropzone.dispatchEvent('drop', { dataTransfer });
}

async function openComposer(page: Page) {
	await signInAsFreshUser(page);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// signInAsFreshUser already left the page on /chat. A second goto here reloaded it mid-setup,
	// which the gallery read as a 1.1 s blank no visitor ever sees (CUR-3615).
	await installCannedReplies(page);
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

test(
	'a dropped file over the per-message limit is refused in the banner with the number the server enforces, and never attached',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openComposer(page);
		// Row 9: a file too big for one message is refused with the number, never half-attached.
		await journeyStep(page, 'A6', 9, async () => {
			await dropText(page, 'too-big.txt', LIMIT_BYTES + 1_000);
			await expect(page.getByText(REFUSAL), 'the over-limit drop showed no refusal').toBeVisible({
				timeout: 10_000
			});
			await expect(
				page.getByText('too-big.txt'),
				'the refused file still sits in the composer as an attachment'
			).toHaveCount(0);
		});
	}
);

test(
	'a dropped file just under the per-message limit is attached, and the server accepts the message that carries it',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openComposer(page);
		await dropText(page, 'just-fits.txt', LIMIT_BYTES - 1_000);
		await expect(
			page.getByText('just-fits.txt').first(),
			'a file under the stated limit was not attached'
		).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(REFUSAL)).toHaveCount(0);

		// The send is the half the composer cannot vouch for: a body past Vercel's 4.5 MB cap is
		// refused with a 413 before any handler runs, whatever the composer admitted.
		const sent = page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/chat\/conversation\/[^/?]+$/.test(new URL(res.url()).pathname),
			{ timeout: 45_000 }
		);
		await page.getByLabel('Message AI Potluck').fill('How many lines does this file have?');
		await page.keyboard.press('Enter');
		const res = await sent;
		expect(
			res.status(),
			'the server refused a message whose attachments the composer admitted'
		).toBeLessThan(400);
	}
);

// The file picker took a .zip no reader opens and a .tiff the composer can't draw, with no
// word. `setFiles` skips the dialog's own type filter, the way choosing "All files" in it does.
test(
	'a .zip or a .tiff chosen in the file picker is refused in the banner by name, and never attached',
	{ tag: ['@preview-only', '@A6', '@CUR-3051', '@CUR-3615'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openComposer(page);
		const attach = page.getByRole('button', { name: /^Add files and tools/ });

		await attach.click();
		let chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Attach files' }).click();
		await (
			await chooser
		).setFiles({ name: 'receipts.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });
		await expect(
			page.getByText("This file type can't be attached here: ZIP file."),
			'a .zip from the picker showed no refusal'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByText('receipts.zip'),
			'the refused .zip still sits in the composer as an attachment'
		).toHaveCount(0);

		await attach.click();
		chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Attach files' }).click();
		await (
			await chooser
		).setFiles({ name: 'scan.tiff', mimeType: 'image/tiff', buffer: Buffer.from('II*\0') });
		await expect(
			page.getByText("This file type can't be attached here: TIFF file."),
			'a .tiff from the picker showed no refusal'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByAltText('scan.tiff').or(page.getByText('scan.tiff')),
			'the refused .tiff still sits in the composer, where it draws as a broken image'
		).toHaveCount(0);
	}
);

// A photo pasted into the composer used to be dropped without a word. Guests cannot attach
// files at all, so a guest's paste of a photo and a text file attaches neither, and the
// composer says to sign in rather than letting them vanish.
test(
	'a photo and a text file a guest pastes are not attached, and the composer asks them to sign in rather than dropping them silently',
	{ tag: ['@preview-only', '@A6', '@CUR-2949'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto('/chat', { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		await composer.evaluate((el) => {
			// A 1×1 PNG: the type is what the composer filters on, not the pixels.
			const png = Uint8Array.from(
				atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/'),
				(c) => c.charCodeAt(0)
			);
			const data = new DataTransfer();
			data.items.add(new File([png], 'pasted-photo.png', { type: 'image/png' }));
			data.items.add(new File(['meeting notes'], 'pasted-notes.txt', { type: 'text/plain' }));
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		});

		await expect(
			page.getByTestId('attachment-refusal'),
			'the refused paste vanished with no word on the composer'
		).toContainText('Sign in to attach files.', { timeout: 10_000 });
		await expect(
			page.getByText('pasted-photo.png'),
			'the refused photo still sits in the composer as an attachment'
		).toHaveCount(0);
		await expect(
			page.getByText('pasted-notes.txt'),
			'a guest attached a text file, though guests cannot attach files'
		).toHaveCount(0);
	}
);
