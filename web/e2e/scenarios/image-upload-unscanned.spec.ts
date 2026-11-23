// e2e-product: @chat
// e2e-area: @composer @storage
import { test, expect, type Page } from './helpers/test';
import sharp from 'sharp';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { journeyStep } from './helpers/journeyStep';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';
import { failIfStorageThrottled } from './helpers/storageThrottle';
import { startChattingPastWelcome } from './helpers/welcome';

// Image uploads stay on where no known-CSAM hash scanner is configured, which is every hosted
// deployment today (csamScan.ts): the image is taken, and the server logs one line that no hash check
// ran. A configured scanner still checks each picture and refuses the upload when it cannot answer.
// These tests read the person's side of that: an image is stored in My files and a photo is sent in
// chat, with no "couldn't check this file" refusal on either path. Run against a deployment whose
// CSAM_SCAN_* keys are unset, they show the no-scanner path takes uploads.

const NOT_CHECKED = "We couldn't check this file just now";

async function bluePng(): Promise<Buffer> {
	return sharp({ create: { width: 64, height: 64, channels: 3, background: '#1040d0' } })
		.png()
		.toBuffer();
}

/** The status the storage endpoint answered for one image set on the page's file input. Retried until
 *  the upload request is actually sent, since a file set before hydration is silently dropped. */
async function uploadImage(page: Page, name: string, buffer: Buffer): Promise<number> {
	let status = 0;
	await failIfStorageThrottled(page);
	await expect(async () => {
		const uploaded = page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
			{ timeout: 10_000 }
		);
		await page
			.locator('input[type=file]')
			.first()
			.setInputFiles({ name, mimeType: 'image/png', buffer });
		status = (await uploaded).status();
	}).toPass({ timeout: 45_000, intervals: STORAGE_POLL_INTERVALS });
	return status;
}

async function listedNames(page: Page): Promise<string[]> {
	const res = await page.request.get('/chat/api/storage');
	expect(res.status(), 'the storage list endpoint did not answer 200').toBe(200);
	return ((await res.json()) as { files: { path: string }[] }).files.map(
		(f) => f.path.split('/').pop() ?? ''
	);
}

test(
	'an image added to My files is stored and listed, with no could-not-check refusal',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		try {
			// A3 row 15: an image added to My files is kept and listed.
			await journeyStep(page, 'A3', 15, async () => {
				const status = await uploadImage(page, 'garden.png', await bluePng());
				expect(
					status,
					`an image answered ${status}, so My files refused it instead of storing it`
				).toBe(201);
				expect(await listedNames(page), 'the stored image is not listed').toContain('garden.png');
				await expect(
					page.getByText(NOT_CHECKED),
					'My files said the image could not be checked'
				).toHaveCount(0);
			});
		} finally {
			// The image is a real file in the bucket; the fresh account is removed by the e2e cleanup.
			const res = await page.request.get('/chat/api/storage').catch(() => null);
			const files = res?.ok() ? ((await res.json()) as { files: { path: string }[] }).files : [];
			for (const f of files) {
				await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(f.path)}`);
			}
		}
	}
);

// `@real-screen`: the photo turn goes through the real input safety screen, as on www, and a small
// harmless picture with an everyday question must be answered, not declined.
test(
	'a photo attached in chat is sent with the question and answered, never left out as unchecked or declined',
	{ tag: ['@preview-only', '@real-screen', '@A3', '@A6'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		// `multimodal` is team-only on preview, and signInAsFreshUser mints an @example.org team account.
		await signInAsFreshUser(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		const b64 = (await bluePng()).toString('base64');
		await composer.evaluate(
			(el, { b64 }) => {
				const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const data = new DataTransfer();
				data.items.add(new File([raw], 'square.png', { type: 'image/png' }));
				el.dispatchEvent(
					new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
				);
			},
			{ b64 }
		);
		await expect(
			page.getByAltText('square.png').or(page.getByText('square.png')).first(),
			'the composer did not attach the photo, so photo attachments are off here'
		).toBeVisible({ timeout: 10_000 });

		// A3 row 16: the photo goes with the question, and nothing says it could not be checked.
		await journeyStep(page, 'A3', 16, async () => {
			await composer.fill('Reply with the single word: ready.');
			await composer.press('Enter');
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(
				turnDone(answer),
				'no finished answer to the photo turn' + warmupContext()
			).toBeVisible({ timeout: 90_000 });
			await expect(answer).toContainText(/ready/i);
			const sent = page.locator('[data-message-type="user"]').last();
			await expect(
				sent.locator('[data-left-out-file]'),
				'the photo was left out of the sent message'
			).toHaveCount(0);
			await expect(
				page.getByText(NOT_CHECKED),
				'chat said the photo could not be checked'
			).toHaveCount(0);
		});
	}
);
