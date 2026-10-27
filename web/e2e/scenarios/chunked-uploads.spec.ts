// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { createHash } from 'node:crypto';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { failIfStorageThrottled } from './helpers/storageThrottle';

// My files took nothing over 4.4 MB, because Vercel refuses a request body over 4.5 MB
// before any handler runs. With `chunked-uploads` on, the page sends a larger file in 4 MB chunks and
// the server reassembles it and runs every upload check on the whole file, up to 20 MB.
//
// Each test forces `chunked-uploads` to the state it covers, as the flag registry requires
// (flagKeys.spec.ts). A fresh example.org account on a preview is inside the flag's team condition
// anyway, so the forced on matches what a staff tester gets there.

const ON_LIMIT = '20 MB';
const OFF_LIMIT = '4.4 MB';

async function openMyFiles(page: Page): Promise<void> {
	await page.goto('/chat/storage', { waitUntil: 'commit' });
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
}

/** The account's stored paths, read from the app's own listing. */
async function listedPaths(page: Page): Promise<string[]> {
	await failIfStorageThrottled(page);
	const res = await page.request.get('/chat/api/storage');
	expect(res.status(), 'the storage list endpoint did not answer 200').toBe(200);
	return ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path);
}

/** Deletes what the account holds. Never throws, so a cleanup failure cannot hide the real one. */
async function removeLeftovers(page: Page): Promise<void> {
	try {
		for (const path of await listedPaths(page)) {
			await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(path)}`);
		}
	} catch (err) {
		test
			.info()
			.annotations.push({ type: 'cleanup', description: `cleanup failed: ${String(err)}` });
	}
}

/** Text that is not one repeated byte, so a chunk joined out of order changes the hash. */
function bigText(bytes: number): Buffer {
	const buf = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i++) buf[i] = 97 + ((i * 7 + (i >> 12)) % 26);
	return buf;
}

test(
	'a 15 MB file uploads in chunks and downloads byte for byte, and a file over 20 MB never reaches the bucket',
	{ tag: ['@preview-only', '@CUR-1780'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true,
			'chunked-uploads': true
		});
		await signInAsFreshUser(page);
		await openMyFiles(page);

		// The limit the page names is the one the server enforces.
		await expect(
			page.getByText(`up to ${ON_LIMIT}`),
			`My files does not name the ${ON_LIMIT} ceiling with chunked-uploads forced on`
		).toBeVisible({ timeout: 30_000 });

		const name = 'field-survey-scans.txt';
		const body = bigText(15_000_000);
		const chunkPosts: number[] = [];
		page.on('response', (r) => {
			if (r.request().method() === 'POST' && /\/chat\/api\/storage\/chunks$/.test(r.url())) {
				chunkPosts.push(r.status());
			}
		});

		try {
			await failIfStorageThrottled(page);
			const completed = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' && r.url().includes('/chat/api/storage/chunks/complete'),
				{ timeout: 120_000 }
			);
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/plain', buffer: body });
			const done = await completed;
			expect(
				done.status(),
				`finishing the upload answered ${done.status()}: ${await done.text()}`
			).toBe(201);
			expect(chunkPosts, 'the file was not sent as four 4 MB chunks, each accepted').toEqual([
				201, 201, 201, 201
			]);

			await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
				timeout: 30_000
			});

			const path = (await listedPaths(page)).find((p) => p.endsWith(name));
			expect(path, `${name} is not in the account's listing after a 201`).toBeTruthy();
			const download = await page.request.get(
				`/chat/api/storage/file?path=${encodeURIComponent(path!)}`
			);
			expect(download.status()).toBe(200);
			const got = await download.body();
			expect(got.length, 'the stored file is not the size that was sent').toBe(body.length);
			expect(
				createHash('sha256').update(got).digest('hex'),
				'the stored file differs from the one sent, so the chunks were joined wrong'
			).toBe(createHash('sha256').update(body).digest('hex'));

			// Over the ceiling: the page refuses it by name, and nothing new is stored.
			const before = (await listedPaths(page)).length;
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({
					name: 'too-big.txt',
					mimeType: 'text/plain',
					buffer: bigText(21_000_000)
				});
			await expect(page.getByText(`over the ${ON_LIMIT} limit per file`)).toBeVisible({
				timeout: 30_000
			});

			// The server holds the same line when the page is bypassed: an announced 21 MB is refused 413.
			const direct = await page.request.post('/chat/api/storage/chunks/complete', {
				data: {
					uploadId: 'e2etoobig0001',
					chunks: 6,
					size: 21_000_000,
					name: 'too-big.txt',
					folder: 'documents'
				}
			});
			expect(direct.status(), 'the finishing route accepted an announced size over 20 MB').toBe(
				413
			);
			expect(await listedPaths(page), 'a file over 20 MB was stored').toHaveLength(before);
		} finally {
			await removeLeftovers(page);
		}
	}
);

test(
	'with chunked-uploads off, My files names the 4.4 MB ceiling and the chunk routes are absent',
	{ tag: ['@preview-only', '@CUR-1780'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true,
			'chunked-uploads': false
		});
		await signInAsFreshUser(page);
		await openMyFiles(page);

		await expect(page.getByText(`up to ${OFF_LIMIT}`)).toBeVisible({ timeout: 30_000 });
		// From the page, as the client sends it: a multipart POST with no Origin header (page.request)
		// is refused 403 by SvelteKit's CSRF check before the route runs, which proves nothing here.
		const status = await page.evaluate(async () => {
			const form = new FormData();
			form.set('uploadId', 'e2eoffcheck01');
			form.set('idx', '0');
			form.set('chunk', new Blob([new Uint8Array([1, 2, 3])]));
			return (await fetch('/chat/api/storage/chunks', { method: 'POST', body: form })).status;
		});
		expect(status, 'the chunk route answered while its flag is off').toBe(404);
	}
);
