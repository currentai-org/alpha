// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { journeyStep } from './helpers/journeyStep';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';

// Every My files refusal names the limit it hit and what to do next
// (`storageRefusalMessage` in custodialUpload.ts) (CUR-2631). The too-large and wrong-type refusals come from the
// real client check and the real server; the hourly and storage-full refusals would take 60 uploads
// or a full 250 MB account to reach, so their upload response is answered with that status here and
// the spec reads what the page makes of it. The server's status per limit is covered by
// routes/chat/api/storage/server.spec.ts. Copy is written out, since a spec imports nothing from src.

async function openMyFiles(
	page: Page,
	context: import('@playwright/test').BrowserContext,
	baseURL: string
) {
	// chunked-uploads off: these refusals name the one-request 4.4 MB ceiling, which a team account on a
	// preview would otherwise not have (CUR-1780).
	await setFlagOverrides(context, baseURL, {
		'custodial-storage-view': true,
		'chunked-uploads': false
	});
	await signInAsFreshUser(page);
	await page.goto('/chat/storage', { waitUntil: 'commit' });
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
}

/** Sets a file on the page's own input, retried until the panel shows a row for it: before
 *  hydration the input has no change handler yet, and a file set then is silently dropped. */
async function addFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
	await expect(async () => {
		await page.locator('input[type=file]').first().setInputFiles({ name, mimeType, buffer });
		await expect(page.getByText(name).first()).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 45_000, intervals: STORAGE_POLL_INTERVALS });
}

/** Answers the next upload POST with `status`; the listing GET goes through untouched. */
async function answerUploadWith(
	page: Page,
	status: number,
	headers: Record<string, string> = {},
	message = `refused with ${status}`
) {
	await page.route('**/chat/api/storage', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await route.fulfill({
			status,
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify({ message })
		});
	});
}

test(
	'each My files refusal names the limit it hit and the way out: too large, wrong type, hourly limit, storage full, too many pictures',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await openMyFiles(page, context, baseURL!);

		await journeyStep(page, 'A3', 13, async () => {
			// Over the per-file limit: refused in the browser before any upload starts.
			await addFile(page, 'too-big.txt', 'text/plain', Buffer.alloc(4_500_000, 'a'));
			await expect(
				page.getByText(
					'That file is over the 4.4 MB limit per file. Compress it or split it, then add it again.'
				),
				'the over-size refusal does not name the per-file limit'
			).toBeVisible({ timeout: 10_000 });

			// A type the server sniffs from the bytes and refuses (an "MZ" header reads as a Windows
			// executable), whatever the name claims.
			const exe = Buffer.alloc(512);
			exe.write('MZ', 0);
			const refused = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
				{ timeout: 30_000 }
			);
			await addFile(page, 'notes.txt', 'text/plain', exe);
			expect((await refused).status(), 'the server did not refuse an executable with 415').toBe(
				415
			);
			await expect(
				page.getByText(/^That file type isn't supported\. Add a TXT, Markdown, CSV, PDF, DOCX/),
				'the wrong-type refusal does not say which types are accepted'
			).toBeVisible({ timeout: 10_000 });

			await answerUploadWith(page, 429, { 'retry-after': '120' });
			await addFile(page, 'hourly.txt', 'text/plain', Buffer.from('hello'));
			await expect(
				page.getByText(
					"You can add 60 files an hour, and you've reached that. Try again in 2 minutes."
				),
				'the hourly-limit refusal does not name the limit and when to retry'
			).toBeVisible({ timeout: 10_000 });
			await page.unrouteAll();

			await answerUploadWith(page, 507);
			await addFile(page, 'full.txt', 'text/plain', Buffer.from('hello'));
			await expect(
				page.getByText('Your storage is full (250 MB). Delete a file to add more.'),
				'the storage-full refusal does not name the quota and the way out'
			).toBeVisible({ timeout: 10_000 });
			await page.unrouteAll();

			// A 422 is a content refusal, and the server's line says which one (CUR-4662). A scanned PDF
			// with one picture per page past the screen's cap must read as that, not as "can't be stored".
			const tooMany =
				"This file has 41 pictures in it, and we can check up to 20 in one file, so it wasn't added. Split it into smaller files of up to 20 pictures and add each one.";
			await answerUploadWith(page, 422, {}, tooMany);
			await addFile(page, 'scanned-manual.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n'));
			await expect(
				page.getByText(tooMany),
				"a 422 refusal shows the generic line instead of the server's reason"
			).toBeVisible({ timeout: 10_000 });
		});
	}
);
