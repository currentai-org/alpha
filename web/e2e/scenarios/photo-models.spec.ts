// e2e-product: @chat
// e2e-area: @composer
import sharp from 'sharp';
import { test, expect, type Page } from './helpers/test';
import type { Locator } from '@playwright/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { plusButton } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// Which models read photos, said where a person meets the difference: the picker marks a
// text-only model, a photo attached for one carries a notice with "Use <a model that reads photos>",
// and with Auto choosing, a photo takes the message to a model that reads it and the composer says
// why. Signed in, since guests cannot attach files (guest-uploads.spec.ts). Production's flags for
// photos and documents are forced on; a text-only model leaves a photo out of what it is sent.

// A model the catalog records as refusing photos (routing/catalog.ts `readsImages`). Apertus reads them.
const TEXT_ONLY_MODEL = 'BSC-LT/ALIA-40b-instruct';

async function photo(): Promise<Buffer> {
	return sharp({ create: { width: 64, height: 64, channels: 3, background: '#1040d0' } })
		.png()
		.toBuffer();
}

async function openSignedIn(page: Page, path: string) {
	await signInAsFreshUser(page);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(path, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

async function attachFromMenu(
	page: Page,
	file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await plusButton(page).click({ timeout: 10_000 });
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('menuitem', { name: /^Attach files/ }).click();
	await (await chooser).setFiles(file);
}

/** Picks a model in the composer's picker, through "Choose a model yourself" where Auto is on. */
async function pickerRow(page: Page, name: RegExp): Promise<Locator> {
	await page.getByRole('button', { name: /^Model: / }).click({ timeout: 10_000 });
	const row = page.getByRole('menuitemradio', { name });
	const yourself = page.getByRole('menuitem', { name: /^Choose a model yourself/ });
	await expect(row.or(yourself).first()).toBeVisible({ timeout: 10_000 });
	if (await yourself.isVisible()) await yourself.click();
	await expect(row).toBeVisible({ timeout: 10_000 });
	return row;
}

test.beforeEach(async ({ context, baseURL }) => {
	await setFlagOverrides(context, baseURL!, {
		multimodal: true,
		'document-attachments': true,
		'agent-mode': false
	});
});

// Files could not be attached: the + button showed only for a model that reads
// photos, so a text-only model had none, and a file let go over the conversation rather than on the box
// standing in for the composer was thrown away without a word.
test(
	'on a text-only model a file attaches from the + menu, and a file dropped on the conversation attaches too',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openSignedIn(page, `/chat/models/${TEXT_ONLY_MODEL}`);

		await attachFromMenu(page, {
			name: 'menu-rota.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('Volunteer rota\nSaturday: bake the bread\n')
		});
		await expect(
			page.getByText('menu-rota.txt').first(),
			'the text file chosen from the + menu never showed as attached'
		).toBeVisible({ timeout: 10_000 });

		const dataTransfer = await page.evaluateHandle(() => {
			const dt = new DataTransfer();
			dt.items.add(
				new File(['Sunday: wash the cups\n'], 'dropped-rota.txt', { type: 'text/plain' })
			);
			return dt;
		});
		const conversation = page.getByRole('main', { name: 'Chat', exact: true });
		await conversation.dispatchEvent('dragenter', { dataTransfer });
		await expect(
			page.getByText('Drop files to attach'),
			'dragging a file showed no dropzone'
		).toBeVisible({
			timeout: 10_000
		});
		// On the conversation, not on the dropzone: the drop lands wherever the file is let go.
		await conversation.dispatchEvent('drop', { dataTransfer });
		await expect(
			page.getByText('dropped-rota.txt').first(),
			'a file dropped on the conversation, away from the dropzone, was not attached'
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByText('menu-rota.txt').first(),
			'the drop replaced the file already attached instead of adding to it'
		).toBeVisible();
	}
);

test(
	'picking a text-only model with a photo attached says it will not see the photo, and Use <model> switches to one that will',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await openSignedIn(page, `/chat/models/${LARGE4_MODEL}`);

		await attachFromMenu(page, { name: 'blue.png', mimeType: 'image/png', buffer: await photo() });
		await expect(page.getByAltText('blue.png').first(), 'the photo never attached').toBeVisible({
			timeout: 10_000
		});
		await expect(page.getByTestId('photos-not-read')).toHaveCount(0);

		const textOnly = await pickerRow(page, /^ALIA 40B/);
		await expect(textOnly, 'the picker did not mark a text-only model').toContainText('Text only');
		await textOnly.click();
		await page.keyboard.press('Escape');

		const notice = page.getByTestId('photos-not-read');
		await expect(
			notice,
			'a photo stayed attached for a text-only model with nothing saying it will not be read'
		).toContainText("can't read photos");
		const use = notice.getByRole('button', { name: /^Use / });
		await expect(use, 'the notice named no model that reads photos').toBeVisible();
		await use.click();
		await expect(
			notice,
			'Use <model> did not move the message to a model that reads photos'
		).toHaveCount(0, {
			timeout: 10_000
		});
		await expect(
			page.getByAltText('blue.png').first(),
			'switching model dropped the photo'
		).toBeVisible();
	}
);

// Chinese routes to GLM 5.2, which reads no photos (routing.spec.ts, CUR-392), so a photo attached to a
// Chinese question is what moves Auto off it. Catalan stays on Mistral Medium, which reads photos, since
// CUR-392, and SEA-LION v4.8 (Vietnamese) drops out of Auto whenever its circuit breaker marks it busy.
test(
	'with Auto choosing, a photo takes the message to a model that reads photos, and the composer says why',
	{ tag: ['@preview-only', '@A6'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, {
			multimodal: true,
			'document-attachments': true,
			'agent-mode': false,
			'auto-routing': true
		});
		const composer = await openSignedIn(page, '/chat');
		await expect(page.getByRole('button', { name: /^Model: Auto/ })).toBeVisible({
			timeout: 10_000
		});

		await composer.fill('请详细解释这张照片里有什么，并告诉我它的主要颜色是什么。');
		await attachFromMenu(page, { name: 'blue.png', mimeType: 'image/png', buffer: await photo() });
		await expect(page.getByAltText('blue.png').first(), 'the photo never attached').toBeVisible({
			timeout: 10_000
		});
		await expect(
			page.getByTestId('auto-photo-switch'),
			'Auto kept a model that cannot read the photo, or switched without saying why'
		).toContainText('can read the photo you attached', { timeout: 15_000 });
		await expect(page.getByTestId('photos-not-read')).toHaveCount(0);
	}
);
