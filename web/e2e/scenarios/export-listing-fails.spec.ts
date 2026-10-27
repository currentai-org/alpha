// e2e-product: @chat
// e2e-area: @settings @storage
import { test, expect } from './helpers/test';
import { readFileSync } from 'node:fs';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { installPageFaultHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { holdForRecording } from './helpers/recording';
import { openArchive } from './helpers/exportArchive';

// A3 row 19 (CUR-2798): the export route lists the person's stored files and, when that listing
// fails, still sends the ZIP and says in its README that no files are in it
// (`api/v2/export/+server.ts`, `exportFormat.ts` `listingFailed`). Only a unit test of the README
// text covered it. This stores a file, fails the listing with the `storage_listing_down` fault, clicks
// the real "Download your data" control, and opens what arrives.

test(
	'an export whose stored-file listing fails still downloads, and its README says no files are in it',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, {
			'data-export': true,
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);

		// A stored file, so a ZIP with no `files/` folder is the fault's doing and not an empty account.
		const name = `kept-${Date.now()}.txt`;
		const stored = await page.request.post('/chat/api/storage', {
			multipart: {
				folder: 'documents',
				file: {
					name,
					mimeType: 'text/plain',
					buffer: Buffer.from('a file the export could not list')
				}
			},
			headers: { origin: new URL(baseURL!).origin }
		});
		expect(stored.status(), `storing the file answered ${stored.status()}`).toBe(201);

		await installPageFaultHeader(page, 'storage_listing_down', '/chat/api/v2/export');

		await journeyStep(page, 'A3', 19, async () => {
			await page.goto('/chat/settings/account', { waitUntil: 'commit' });
			const exportRow = page.getByRole('link', {
				name: 'Download a ZIP of your conversations, files, and where each answer came from'
			});
			await expect(exportRow).toBeVisible({ timeout: 15_000 });
			await holdForRecording(page);

			const [download] = await Promise.all([page.waitForEvent('download'), exportRow.click()]);
			const downloadPath = await download.path();
			if (!downloadPath) throw new Error('download event fired but Playwright kept no local copy');
			const archive = openArchive(readFileSync(downloadPath));

			expect(Object.keys(archive), 'the export lost its conversation manifest').toContain(
				'conversations.json'
			);
			expect(
				Object.keys(archive).filter((n) => n.startsWith('files/')),
				'files arrived although the listing was failed, so the fault never reached the route'
			).toEqual([]);
			expect(
				archive['README.md'],
				'the README does not say the stored files could not be listed'
			).toContain('Your stored files could not be listed when this export ran');
		});
	}
);
