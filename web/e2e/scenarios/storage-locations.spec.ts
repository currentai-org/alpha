// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { journeyStep } from './helpers/journeyStep';
import { answerShapeEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// Storage locations (CUR-2930). A person links a Hugging Face bucket of their own under Settings →
// Storage, chooses where new files go there (Alpha storage, the linked bucket, "Last used" or ask
// every time), and browses either place from the location tabs on the Files page (CUR-4363).
// With Alpha storage the only place there is no choice to make, so the picker appears only
// once a bucket is linked (CUR-3077).
//
// The first three tests need no Hugging Face token: they walk the surface from /chat, and pin the
// refusals (a bad token, a location id that is not yours).
//
// The `@linked-bucket` tests link a real bucket, `current-ai-official/e2e-linked`, with the
// preview environment's `E2E_LINKED_BUCKET_TOKEN`, a token scoped to that one bucket. playwright.config.ts leaves
// `@linked-bucket` out unless SCENARIO_LINKED_BUCKET=1, which the workflow sets when the token is there.

const LINKED_BUCKET = 'current-ai-official/e2e-linked';

// Settings → Storage holds the storage settings (usage, locations, linking a bucket, where
// files are kept) (CUR-4363); the files, the location tabs and the uploader are on the rail's Files page.
async function openStorageSettings(page: Page): Promise<void> {
	await page.goto('/chat', { waitUntil: 'commit' });
	await page.goto('/chat/settings/storage', { waitUntil: 'commit' });
	await expect(page.getByRole('heading', { name: 'Usage', level: 2 })).toBeVisible({
		timeout: 30_000
	});
	await expect(page.getByTestId('storage-locations')).toBeVisible({ timeout: 30_000 });
}

/** From Settings → Storage, the files page through its own "Open your files" link. */
async function openFilesFromSettings(page: Page): Promise<void> {
	await page.getByRole('link', { name: 'Open your files' }).click();
	await expect(page).toHaveURL(/\/chat\/storage$/, { timeout: 15_000 });
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
}

/** The storage location tabs on the Files page (CUR-4363). */
const locationTabs = (page: Page) => page.getByRole('tablist', { name: 'Storage location' });

/** Links the e2e bucket under a fresh folder, and returns its row and location id. */
async function linkTestBucket(page: Page, token: string) {
	const folder = `e2e-linked/${Date.now().toString(36)}`;
	const form = page.getByTestId('link-bucket-form');
	await form.getByLabel('Bucket').fill(LINKED_BUCKET);
	await form.getByLabel('Folder (optional)').fill(folder);
	await form.getByLabel('Access token').fill(token);
	await form.getByRole('button', { name: 'Link bucket' }).click();
	const row = page.locator('[data-testid=storage-location]').filter({ hasText: 'e2e-linked' });
	await expect(row, 'the linked bucket is not listed').toBeVisible({ timeout: 30_000 });
	const locationId = await row.getAttribute('data-location-id');
	return { folder, row, locationId: locationId! };
}

/** Removes a test file from the e2e bucket; a failure is an annotation, never the test's verdict. */
async function deleteBucketFile(token: string, path: string): Promise<void> {
	const { deleteFile } = await import('@huggingface/hub');
	await deleteFile({ repo: `buckets/${LINKED_BUCKET}`, path, accessToken: token }).catch((err) =>
		test.info().annotations.push({
			type: 'cleanup',
			description: `could not delete test file: ${String(err)}`
		})
	);
}

async function flagsOn(
	context: Parameters<typeof setFlagOverrides>[0],
	baseURL: string
): Promise<void> {
	await setFlagOverrides(context, baseURL, {
		'custodial-storage-view': true,
		'storage-locations': true
	});
}

test(
	'Settings → Storage shows usage, Locations, linking your own bucket and where files are kept as headed sections with no file list, and refuses a token Hugging Face does not accept, with its reason',
	{ tag: ['@preview-only', '@A3', '@CUR-2930'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);

		// Reached through the UI: the settings nav's Storage entry, not a typed URL.
		await page.goto('/chat/settings', { waitUntil: 'commit' });
		await page
			.getByRole('link', {
				name: 'How much storage you use, where new files go, and linked buckets'
			})
			.click({ timeout: 30_000 });
		await expect(page.getByTestId('storage-locations')).toBeVisible({ timeout: 30_000 });

		// With Alpha storage the only place, it is a plain line (CUR-3077): no picker, no "Ask every
		// time", no "Last used".
		const card = page.getByTestId('storage-locations');
		const alpha = card.locator('[data-testid=storage-location][data-location-id=alpha]');
		await expect(alpha).toContainText('Alpha storage');
		await expect(card.getByRole('radiogroup', { name: 'Where new files go' })).toHaveCount(0);
		await expect(card.getByRole('radio')).toHaveCount(0);
		await expect(card).not.toContainText('Ask every time');
		await expect(card).not.toContainText('Last used');

		// The settings page is the settings, in headed sections and in this order, with the
		// bucket form in plain view and no file list or uploader (CUR-4363); the files are one link away.
		await expect(
			page.getByTestId('storage-settings').getByRole('heading', { level: 2 })
		).toHaveText([
			'Usage',
			'Locations',
			'Link your own Hugging Face bucket',
			'Where your files are kept'
		]);
		await expect(page.getByTestId('storage-usage').getByRole('meter')).toBeVisible();
		await expect(alpha.getByTestId('location-file-count')).toHaveText('0 files');
		await expect(page.getByTestId('storage-where-kept')).toContainText('stored with Hugging Face');
		await expect(page.getByTestId('link-bucket-form')).toBeVisible();
		await expect(
			page.locator('input[type=file]'),
			'the settings page still has an uploader'
		).toHaveCount(0);
		await expect(page.locator('[data-file-row]')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Open your files' })).toHaveAttribute(
			'href',
			'/chat/storage'
		);

		await journeyStep(page, 'A3', 21, async () => {
			const form = page.getByTestId('link-bucket-form');
			await form.getByLabel('Bucket').fill(LINKED_BUCKET);
			await form.getByLabel('Access token').fill('hf_this_is_not_a_real_token_000000');
			const linked = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage/locations')
			);
			await form.getByRole('button', { name: 'Link bucket' }).click();
			expect((await linked).status(), 'a token Hugging Face rejects must not be linked').toBe(400);
			await expect(page.getByTestId('link-bucket-error')).toContainText(
				"Hugging Face didn't accept that token"
			);
			await expect(page.locator('[data-testid=storage-location]')).toHaveCount(1);
		});
	}
);

test(
	'with storage-locations off, the Storage page shows no place to link a bucket and every location route is a 404',
	{ tag: ['@preview-only', '@A3', '@CUR-2930'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true,
			'storage-locations': false
		});
		await signInAsFreshUser(page);
		await page.goto('/chat/settings/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Usage', level: 2 })).toBeVisible({
			timeout: 30_000
		});
		await expect(
			page.getByTestId('storage-locations'),
			'the locations card shows with the flag off'
		).toHaveCount(0);
		await expect(page.getByTestId('storage-link-section')).toHaveCount(0);
		// The files page has no location tabs with the flag off either.
		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});
		await expect(page.getByTestId('location-tabs')).toHaveCount(0);

		const list = await page.request.get('/chat/api/storage/locations');
		expect(list.status(), 'listing locations with the flag off').toBe(404);
		const link = await page.request.post('/chat/api/storage/locations', {
			data: { bucket: LINKED_BUCKET, token: 'hf_not_a_token' }
		});
		expect(link.status(), 'linking a bucket with the flag off').toBe(404);
		const transfer = await page.request.post('/chat/api/storage/transfer', {
			data: { from: 'alpha', to: 'alpha', path: 'documents/a.txt', mode: 'copy' }
		});
		expect(transfer.status(), 'transferring a file with the flag off').toBe(404);
	}
);

test(
	'a location id that is not this account’s is a 404 on every location route, never someone else’s files',
	{ tag: ['@preview-only', '@A3', '@CUR-2930'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);
		const foreign = 'aaaaaaaaaaaaaaaaaaaaaaaa';

		const list = await page.request.get(`/chat/api/storage?location=${foreign}`);
		expect(list.status(), 'listing a foreign location id').toBe(404);
		const read = await page.request.get(
			`/chat/api/storage/file?location=${foreign}&path=documents/a.txt`
		);
		expect(read.status(), 'reading through a foreign location id').toBe(404);
		const def = await page.request.put('/chat/api/storage/locations/default', {
			data: { location: foreign }
		});
		expect(def.status(), 'making a foreign location id the default').toBe(404);
		const unlink = await page.request.delete(`/chat/api/storage/locations/${foreign}`);
		expect(unlink.status(), 'unlinking a foreign location id').toBe(404);
		// Neither end of a transfer may be someone else's location (CUR-2931).
		for (const [from, to] of [
			['alpha', foreign],
			[foreign, 'alpha']
		]) {
			const transfer = await page.request.post('/chat/api/storage/transfer', {
				data: { from, to, path: 'documents/a.txt', mode: 'move' }
			});
			expect(transfer.status(), `transferring from ${from} to ${to}`).toBe(404);
		}
	}
);

// Signed in fresh, with the e2e bucket linked and "Ask every time" saved as the default. The radio
// only exists while a bucket is linked, so both "ask" tests start here.
async function linkedWithAskSaved(
	page: Page,
	context: Parameters<typeof setFlagOverrides>[0],
	baseURL: string,
	token: string
) {
	await flagsOn(context, baseURL);
	await signInAsFreshUser(page);
	await openStorageSettings(page);
	const origin = new URL(baseURL).origin;
	const unnamedUpload = (name: string) =>
		page.request.post('/chat/api/storage', {
			headers: { origin },
			multipart: {
				folder: 'documents',
				file: { name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) }
			}
		});
	const linked = await linkTestBucket(page, token);
	const saved = page.waitForResponse((r) =>
		r.url().endsWith('/chat/api/storage/locations/default')
	);
	await page.getByRole('radio', { name: /Ask every time/ }).click();
	expect((await saved).ok(), 'choosing "Ask every time" was not saved').toBe(true);
	await page.reload({ waitUntil: 'commit' });
	await expect(page.getByRole('radio', { name: /Ask every time/ })).toBeChecked({
		timeout: 30_000
	});
	return { ...linked, unnamedUpload };
}

test(
	'with a bucket linked and "Ask every time" as the default, adding a file asks where it should go first, and it lands where the person chose',
	{ tag: ['@preview-only', '@A3', '@CUR-2930', '@CUR-3077', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await journeyStep(page, 'A3', 23, async () => {
			const { locationId, unnamedUpload } = await linkedWithAskSaved(
				page,
				context,
				baseURL!,
				token!
			);
			try {
				// The server holds the same line as the UI: an upload that names no place goes nowhere.
				expect(
					(await unnamedUpload('unnamed.txt')).status(),
					'an upload naming no location went somewhere anyway'
				).toBe(409);

				// Files are added on the Files page (CUR-4363).
				await openFilesFromSettings(page);
				const name = 'asked-first.txt';
				await page
					.locator('input[type=file]')
					.first()
					.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('asked first\n') });
				const dialog = page.getByTestId('choose-location-dialog');
				await expect(dialog, 'adding a file under "Ask every time" did not ask').toBeVisible({
					timeout: 15_000
				});
				await expect(dialog).toContainText('Where should this file go?');
				const uploaded = page.waitForResponse(
					(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
				);
				await dialog.getByRole('radio', { name: /Alpha storage/ }).click();
				await dialog.getByRole('button', { name: 'Add' }).click();
				const body = (await (await uploaded).json()) as { location: string; path: string };
				expect(body.location, 'the file did not go where the person chose').toBe('alpha');
				await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
					timeout: 30_000
				});
			} finally {
				await page.request.delete(`/chat/api/storage/locations/${locationId}`);
			}
		});
	}
);

test(
	'with "Ask every time" still saved after the only linked bucket is unlinked, Alpha storage is the one place left, so there is no picker and every upload goes there with no prompt',
	{ tag: ['@preview-only', '@A3', '@CUR-3077', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		const { row, locationId, unnamedUpload } = await linkedWithAskSaved(
			page,
			context,
			baseURL!,
			token!
		);
		let unlinked = false;
		try {
			await row.getByRole('button', { name: /Unlink/ }).click();
			await row.getByRole('button', { name: 'Unlink', exact: true }).click();
			await expect(row).toHaveCount(0, { timeout: 30_000 });
			unlinked = true;
			const card = page.getByTestId('storage-locations');
			await expect(card.getByRole('radio')).toHaveCount(0);
			await expect(card).not.toContainText('Ask every time');

			const unnamed = await unnamedUpload('after-unlink.txt');
			expect(unnamed.status(), 'a saved "ask" with one place left still refused the upload').toBe(
				201
			);
			expect(((await unnamed.json()) as { location: string }).location).toBe('alpha');

			await openFilesFromSettings(page);
			const name = 'no-prompt.txt';
			const uploaded = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
			);
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('no prompt\n') });
			const body = (await (await uploaded).json()) as { location: string };
			expect(body.location, 'the upload did not go to Alpha storage').toBe('alpha');
			await expect(
				page.getByTestId('choose-location-dialog'),
				'a saved "ask" with only Alpha storage still asked'
			).toHaveCount(0);
			await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
				timeout: 30_000
			});
		} finally {
			if (!unlinked) await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

test(
	'link my own bucket, make it the default, add a file that lands there, then unlink and the file stays in my bucket',
	{ tag: ['@preview-only', '@A3', '@CUR-2930', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);
		await openStorageSettings(page);

		const folder = `e2e-linked/${Date.now().toString(36)}`;
		const form = page.getByTestId('link-bucket-form');
		await form.getByLabel('Bucket').fill(LINKED_BUCKET);
		await form.getByLabel('Folder (optional)').fill(folder);
		await form.getByLabel('Access token').fill(token!);
		await form.getByRole('button', { name: 'Link bucket' }).click();

		const row = page.locator('[data-testid=storage-location]').filter({ hasText: 'e2e-linked' });
		await expect(row, 'the linked bucket is not listed').toBeVisible({ timeout: 30_000 });
		const locationId = await row.getAttribute('data-location-id');
		// With a bucket of their own linked, the page no longer says they need no Hugging Face account.
		await expect(page.getByTestId('storage-where-kept')).toContainText(
			'its files stay in your own Hugging Face account'
		);
		await expect(page.getByTestId('storage-where-kept')).not.toContainText(
			"You don't need a Hugging Face account"
		);

		let unlinked = false;
		const name = 'linked-bucket-note.txt';
		try {
			const saved = page.waitForResponse((r) =>
				r.url().endsWith('/chat/api/storage/locations/default')
			);
			await row.getByRole('radio').click();
			expect((await saved).ok(), 'making the linked bucket the default was not saved').toBe(true);
			await openFilesFromSettings(page);
			// The Files page opens on the default, so the linked bucket's tab is the selected one, and the
			// open tab is where a dropped file goes (CUR-4363).
			await expect(locationTabs(page).getByRole('tab', { selected: true })).toContainText(
				'e2e-linked',
				{ timeout: 30_000 }
			);

			const uploaded = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
			);
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({
					name,
					mimeType: 'text/plain',
					buffer: Buffer.from('lives in my bucket\n')
				});
			const body = await (await uploaded).json();
			expect(body.location, 'the upload did not go to the default location').toBe(locationId);
			expect(body.path).toBe(`${folder}/documents/${name}`);
			await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
				timeout: 30_000
			});

			// Not in Alpha storage.
			const alpha = await page.request.get('/chat/api/storage');
			const alphaPaths = ((await alpha.json()) as { files: { path: string }[] }).files.map(
				(f) => f.path
			);
			expect(
				alphaPaths.some((p) => p.endsWith(name)),
				'the file also landed in Alpha storage'
			).toBe(false);

			// Unlinking is a setting, on Settings → Storage.
			await page.getByRole('link', { name: 'Manage storage' }).click();
			await expect(page.getByTestId('storage-locations')).toBeVisible({ timeout: 30_000 });
			await row.getByRole('button', { name: /Unlink/ }).click();
			// The confirm says the files stay and how to remove Alpha's token on Hugging Face (CUR-2932).
			await expect(page.getByTestId('storage-unlink-note')).toContainText(
				'The files stay in your bucket'
			);
			await expect(page.getByTestId('hf-access-note-token')).toBeVisible();
			await row.getByRole('button', { name: 'Unlink', exact: true }).click();
			await expect(row).toHaveCount(0, { timeout: 30_000 });
			unlinked = true;
			// Unlinking left Alpha storage the only place, so it is a plain line with no picker (CUR-3077).
			await expect(
				page.locator('[data-testid=storage-location][data-location-id=alpha]')
			).toContainText('Alpha storage');
			await expect(page.getByTestId('storage-locations').getByRole('radio')).toHaveCount(0);
		} finally {
			// The file in the person's bucket is theirs; the test's copy is cleaned up with the token.
			const { deleteFile } = await import('@huggingface/hub');
			await deleteFile({
				repo: `buckets/${LINKED_BUCKET}`,
				path: `${folder}/documents/${name}`,
				accessToken: token!
			}).catch((err) =>
				test.info().annotations.push({
					type: 'cleanup',
					description: `could not delete test file: ${String(err)}`
				})
			);
			if (!unlinked && locationId)
				await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

test(
	'Forget everything names my linked bucket as staying in my Hugging Face account, then forgets only the link',
	{ tag: ['@preview-only', '@A3', '@CUR-2932', '@CUR-3386', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);

		// Data & privacy says where files live, and once a bucket is linked that is two places (CUR-3386).
		await page.goto('/chat/settings/data', { waitUntil: 'commit' });
		const filesHome = page.getByTestId('data-home-files');
		await expect(filesHome).toContainText('in storage held by Current AI', { timeout: 30_000 });
		await expect(filesHome).not.toContainText('A bucket you linked');

		await openStorageSettings(page);
		const form = page.getByTestId('link-bucket-form');
		await form.getByLabel('Bucket').fill(LINKED_BUCKET);
		await form.getByLabel('Folder (optional)').fill(`e2e-linked/${Date.now().toString(36)}`);
		await form.getByLabel('Access token').fill(token!);
		await form.getByRole('button', { name: 'Link bucket' }).click();
		await expect(
			page.locator('[data-testid=storage-location]').filter({ hasText: 'e2e-linked' })
		).toBeVisible({ timeout: 30_000 });

		// A fresh account, so wiping it costs nothing shared.
		await page.goto('/chat/settings/data', { waitUntil: 'commit' });
		await expect(
			filesHome,
			'Data & privacy still says every file is held by Current AI with a bucket linked'
		).toContainText('its files stay in your own Hugging Face account', { timeout: 30_000 });
		await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 30_000 });
		const stays = page.getByTestId('wipe-linked-storage');
		await expect(stays, 'the confirm does not say the bucket stays').toContainText(LINKED_BUCKET, {
			timeout: 15_000
		});
		await expect(stays).toContainText('stays in your Hugging Face account');
		await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 15_000
		});
		await expect(
			page.getByTestId('wipe-linked-storage-done').getByTestId('hf-access-note-token')
		).toBeVisible();

		const after = await page.request.get('/chat/api/storage/locations');
		const kinds = ((await after.json()) as { locations: { kind: string }[] }).locations.map(
			(l) => l.kind
		);
		expect(kinds, 'the wipe left the link to the bucket').toEqual(['alpha']);
	}
);

// Delete account forgets the link but never the bucket, which is the person's own, and Hugging
// Face has no endpoint for Alpha to drop its own access (CUR-2932). So the confirm names the bucket as staying, the
// done panel says where to remove Alpha's access, and with nothing linked neither line appears.
test(
	'Delete account names my linked bucket as staying and says where to remove Alpha’s access, and says neither with no bucket linked',
	{ tag: ['@preview-only', '@A3', '@CUR-2932', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		const openDeleteAccount = async () => {
			await page.goto('/chat/settings/account', { waitUntil: 'commit' });
			await page
				.getByRole('button', { name: 'Delete your account, conversations, and sign-in methods' })
				.click({ timeout: 30_000 });
			await expect(page.getByLabel('Type DELETE to confirm')).toBeVisible({ timeout: 15_000 });
		};

		// No bucket linked: the confirm and the done panel stay silent about Hugging Face.
		await signInAsFreshUser(page);
		await openDeleteAccount();
		await expect(page.getByTestId('wipe-linked-storage')).toHaveCount(0);
		await page.getByLabel('Type DELETE to confirm').fill('DELETE');
		await page.getByRole('button', { name: 'Delete account', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 60_000
		});
		await expect(page.getByTestId('wipe-linked-storage-done')).toHaveCount(0);

		// A bucket linked: the confirm names it, and the done panel links the token page.
		await context.clearCookies({ name: /session_token/ });
		await signInAsFreshUser(page);
		await openStorageSettings(page);
		const form = page.getByTestId('link-bucket-form');
		await form.getByLabel('Bucket').fill(LINKED_BUCKET);
		await form.getByLabel('Folder (optional)').fill(`e2e-linked/${Date.now().toString(36)}`);
		await form.getByLabel('Access token').fill(token!);
		await form.getByRole('button', { name: 'Link bucket' }).click();
		await expect(
			page.locator('[data-testid=storage-location]').filter({ hasText: 'e2e-linked' })
		).toBeVisible({ timeout: 30_000 });

		await openDeleteAccount();
		const stays = page.getByTestId('wipe-linked-storage');
		await expect(stays, 'the delete-account confirm does not name the bucket').toContainText(
			LINKED_BUCKET,
			{ timeout: 15_000 }
		);
		await expect(stays).toContainText('stays in your Hugging Face account');
		await page.getByLabel('Type DELETE to confirm').fill('DELETE');
		await page.getByRole('button', { name: 'Delete account', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
			timeout: 60_000
		});
		await expect(
			page.getByTestId('wipe-linked-storage-done').getByTestId('hf-access-note-token'),
			'the done panel does not say where to remove Alpha’s token'
		).toBeVisible();
	}
);

test(
	'move a file from Alpha storage to my bucket and it is only there, copy it back and it is in both, and a second copy is refused rather than overwriting',
	{ tag: ['@preview-only', '@A3', '@CUR-2931', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);
		await openStorageSettings(page);

		const folder = `e2e-linked/${Date.now().toString(36)}`;
		const form = page.getByTestId('link-bucket-form');
		await form.getByLabel('Bucket').fill(LINKED_BUCKET);
		await form.getByLabel('Folder (optional)').fill(folder);
		await form.getByLabel('Access token').fill(token!);
		await form.getByRole('button', { name: 'Link bucket' }).click();
		const row = page.locator('[data-testid=storage-location]').filter({ hasText: 'e2e-linked' });
		await expect(row, 'the linked bucket is not listed').toBeVisible({ timeout: 30_000 });
		const locationId = await row.getAttribute('data-location-id');

		const name = 'moved-note.txt';
		const filesIn = async (location?: string): Promise<string[]> => {
			const res = await page.request.get(
				`/chat/api/storage${location ? `?location=${location}` : ''}`
			);
			expect(res.status(), `listing ${location ?? 'alpha'}`).toBe(200);
			return ((await res.json()) as { files: { path: string }[] }).files
				.map((f) => f.path)
				.filter((p) => p.endsWith(`/${name}`));
		};
		const transfer = () =>
			page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage/transfer')
			);

		try {
			// Add the file to Alpha storage, which is still the default, on the Files page.
			await openFilesFromSettings(page);
			const uploaded = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
			);
			await page
				.locator('input[type=file]')
				.first()
				.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('moves around\n') });
			expect((await uploaded).status(), 'the upload to Alpha storage').toBe(201);

			// Move it to the bucket from the file's own button.
			await page.getByRole('button', { name: `Copy or move ${name}` }).click();
			const dialog = page.getByTestId('transfer-dialog');
			await dialog.getByRole('radio', { name: /e2e-linked/ }).click();
			const moved = transfer();
			await dialog.getByRole('button', { name: 'Move', exact: true }).click();
			expect((await moved).status(), 'the move').toBe(200);
			await expect(page.getByText(`${name} moved to`)).toBeVisible({ timeout: 30_000 });
			expect(await filesIn(), 'the moved file is still in Alpha storage').toEqual([]);
			expect(await filesIn(locationId!), 'the moved file is not in the bucket').toEqual([
				`${folder}/documents/${name}`
			]);

			// Copy it back from the bucket's own view.
			await locationTabs(page)
				.getByRole('tab', { name: /e2e-linked/ })
				.click();
			await expect(locationTabs(page).getByRole('tab', { name: /e2e-linked/ })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await page.getByRole('button', { name: `Copy or move ${name}` }).click();
			await dialog.getByRole('radio', { name: /Alpha storage/ }).click();
			const copied = transfer();
			await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
			expect((await copied).status(), 'the copy back').toBe(200);
			expect(await filesIn(), 'the copy is not in Alpha storage').toHaveLength(1);
			expect(await filesIn(locationId!), 'the copy removed the original').toHaveLength(1);

			// A second copy would overwrite a file with no older versions, so it is refused, in words.
			await page.getByRole('button', { name: `Copy or move ${name}` }).click();
			await dialog.getByRole('radio', { name: /Alpha storage/ }).click();
			const again = transfer();
			await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
			expect((await again).status(), 'a copy onto an existing name').toBe(409);
			await expect(dialog.getByRole('alert')).toContainText(`already a file called ${name}`);
		} finally {
			const { deleteFile } = await import('@huggingface/hub');
			await deleteFile({
				repo: `buckets/${LINKED_BUCKET}`,
				path: `${folder}/documents/${name}`,
				accessToken: token!
			}).catch((err) =>
				test.info().annotations.push({
					type: 'cleanup',
					description: `could not delete test file: ${String(err)}`
				})
			);
			if (locationId) await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

test(
	'with a bucket linked, "Last used" is the default, and after a file goes to my bucket the next upload goes there too',
	{ tag: ['@preview-only', '@A3', '@CUR-3077', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);
		await openStorageSettings(page);

		const { folder, locationId } = await linkTestBucket(page, token!);
		const first = 'last-used-first.txt';
		const second = 'last-used-second.txt';
		const third = 'last-used-unnamed.txt';
		try {
			// Linking a second place brings the picker: each place, then "Last used", then "Ask every time".
			// Names are anchored: "Last used" says where it points, so it also mentions a place's name.
			const card = page.getByTestId('storage-locations');
			const picker = card.getByRole('radiogroup', { name: 'Where new files go' });
			await expect(picker.getByRole('radio')).toHaveCount(4);
			await expect(picker.getByRole('radio', { name: /^Alpha storage/ })).toBeVisible();
			await expect(
				picker.getByRole('radio', { name: /^current-ai-official\/e2e-linked/ })
			).toBeVisible();
			await expect(picker.getByRole('radio', { name: /^Ask every time/ })).toBeVisible();
			const lastUsed = picker.getByRole('radio', { name: /^Last used/ });
			await expect(
				lastUsed,
				'an account that never chose does not start on "Last used"'
			).toBeChecked();

			await journeyStep(page, 'A3', 25, async () => {
				await openFilesFromSettings(page);
				// Two places are two tabs, Alpha storage selected (CUR-4363); ArrowRight from it opens the
				// bucket's tab. Then add a file to the bucket from its own view.
				const tabs = locationTabs(page);
				await expect(tabs.getByRole('tab')).toHaveCount(2);
				const alphaTab = tabs.getByRole('tab', { name: /Alpha storage/ });
				const bucketTab = tabs.getByRole('tab', { name: /e2e-linked/ });
				await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
				await alphaTab.focus();
				await page.keyboard.press('ArrowRight');
				await expect(bucketTab, 'ArrowRight did not move to the next location').toHaveAttribute(
					'aria-selected',
					'true'
				);
				await expect(bucketTab).toBeFocused();
				await expect(alphaTab).toHaveAttribute('aria-selected', 'false');
				const firstUp = page.waitForResponse(
					(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
				);
				await page
					.locator('input[type=file]')
					.first()
					.setInputFiles({ name: first, mimeType: 'text/plain', buffer: Buffer.from('first\n') });
				expect(((await (await firstUp).json()) as { location: string }).location).toBe(locationId);
				await page.getByRole('link', { name: 'Manage storage' }).click();
				await expect(page.getByTestId('storage-last-used')).toContainText('e2e-linked', {
					timeout: 30_000
				});

				// A fresh visit opens on the last-used place, and a file added there lands in the bucket.
				await openFilesFromSettings(page);
				await expect(
					locationTabs(page).getByRole('tab', { selected: true }),
					'a fresh visit did not open on the last-used place'
				).toContainText('e2e-linked', { timeout: 30_000 });
				const secondUp = page.waitForResponse(
					(r) => r.request().method() === 'POST' && r.url().endsWith('/chat/api/storage')
				);
				await page
					.locator('input[type=file]')
					.first()
					.setInputFiles({ name: second, mimeType: 'text/plain', buffer: Buffer.from('second\n') });
				const body = (await (await secondUp).json()) as { location: string; path: string };
				expect(body.location, 'the next upload did not follow "Last used"').toBe(locationId);
				expect(body.path).toBe(`${folder}/documents/${second}`);
			});

			// The server resolves "Last used" too: an upload naming no place goes to the bucket.
			const unnamed = await page.request.post('/chat/api/storage', {
				headers: { origin: new URL(baseURL!).origin },
				multipart: {
					folder: 'documents',
					file: { name: third, mimeType: 'text/plain', buffer: Buffer.from('third\n') }
				}
			});
			expect(unnamed.status()).toBe(201);
			expect(
				((await unnamed.json()) as { location: string }).location,
				'the server did not resolve "Last used" to the bucket'
			).toBe(locationId);
		} finally {
			for (const name of [first, second, third])
				await deleteBucketFile(token!, `${folder}/documents/${name}`);
			await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

// With the linked bucket as the default, a photo attached in a new
// chat still went to Alpha storage. A chat attachment follows the default like an upload on My files,
// and a later turn reads it back from the bucket. Red if the file lands in Alpha storage, lands
// outside the chat's folder in the bucket, or the second turn cannot read it.
test(
	'with my linked bucket as the default, a file attached in chat lands in that bucket under its conversation and a later turn still reads it',
	{ tag: ['@preview-only', '@A3', '@CUR-2930', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		await flagsOn(context, baseURL!);
		await signInAsFreshUser(page);
		await openStorageSettings(page);
		const { row, locationId } = await linkTestBucket(page, token!);

		const name = 'linked-chat-rota.txt';
		let bucketPath: string | undefined;
		try {
			const saved = page.waitForResponse((r) =>
				r.url().endsWith('/chat/api/storage/locations/default')
			);
			await row.getByRole('radio').click();
			expect((await saved).ok(), 'making the linked bucket the default was not saved').toBe(true);

			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			const dataTransfer = await page.evaluateHandle((fileName) => {
				const dt = new DataTransfer();
				dt.items.add(
					new File(
						['Volunteer rota\nSaturday: bake the bread\nSunday: wash the cups\n'],
						fileName,
						{
							type: 'text/plain'
						}
					)
				);
				return dt;
			}, name);
			await page.getByRole('form', { name: 'file dropzone' }).dispatchEvent('dragenter', {
				dataTransfer
			});
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone).toBeVisible({ timeout: 10_000 });
			await dropzone.dispatchEvent('drop', { dataTransfer });
			await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
			await composer.fill('What is on the rota for Saturday?');
			const turnStarted = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' &&
					/\/chat\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
				{ timeout: 60_000 }
			);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
			const conversationId = new URL(page.url()).pathname.split('/').pop()!;
			expect((await turnStarted).ok(), 'the message POST was refused').toBe(true);

			// The POST's headers go out before the attachment is stored (prestream events), so the
			// bucket is read once the first answer has finished.
			const answers = page.locator('[data-message-role="assistant"]');
			await expect(turnDone(answers.first()), 'the first turn never finished').toBeVisible({
				timeout: 90_000
			});

			const alpha = await page.request.get('/chat/api/storage');
			const alphaPaths = ((await alpha.json()) as { files: { path: string }[] }).files.map(
				(f) => f.path
			);
			expect(
				alphaPaths.some((p) => p.endsWith(`/${name}`)),
				'the chat attachment went to Alpha storage despite the linked default'
			).toBe(false);

			const inBucket = await page.request.get(
				`/chat/api/storage?location=${encodeURIComponent(locationId)}`
			);
			expect(inBucket.ok(), 'listing the linked bucket failed').toBe(true);
			bucketPath = ((await inBucket.json()) as { files: { path: string }[] }).files
				.map((f) => f.path)
				.find((p) => p.endsWith(`/${name}`));
			expect(bucketPath, `${name} was not in the linked bucket after its turn`).toBeTruthy();
			expect(
				bucketPath,
				'the attachment reached the bucket but not under its conversation'
			).toContain(`/conversations/${conversationId}/`);

			// The second question is answerable only from the file, so naming the cups shows the turn read
			// the attachment back from the bucket.
			await composer.fill('And what is on the rota for Sunday?');
			await composer.press('Enter');
			await expect(answers).toHaveCount(2, { timeout: 60_000 });
			await expect(turnDone(answers.last()), 'the second turn never finished').toBeVisible({
				timeout: 90_000
			});
			await expect(
				answers.last(),
				'the second turn answered without the attachment kept in the bucket'
			).toContainText(/cups/i);
		} finally {
			if (bucketPath) await deleteBucketFile(token!, bucketPath);
			if (locationId) await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

// Linking a place of your own is when copying there makes sense, so the card offers it at
// that moment (CUR-2941): save new files there (on by default) and copy what is already in Alpha storage (off
// by default). Copy only: old chats read their attachments from Alpha storage, so its copies stay.
async function linkedWithTwoAlphaFiles(
	page: Page,
	context: Parameters<typeof setFlagOverrides>[0],
	baseURL: string,
	token: string
) {
	await flagsOn(context, baseURL);
	await signInAsFreshUser(page);
	const origin = new URL(baseURL).origin;
	const names = ['move-one.txt', 'move-two.txt'];
	for (const name of names) {
		const up = await page.request.post('/chat/api/storage', {
			headers: { origin },
			multipart: {
				folder: 'documents',
				file: { name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) }
			}
		});
		expect(up.status(), `adding ${name} to Alpha storage`).toBe(201);
	}
	await openStorageSettings(page);
	const linked = await linkTestBucket(page, token);
	const filesIn = async (location?: string): Promise<string[]> => {
		const res = await page.request.get(
			`/chat/api/storage${location ? `?location=${location}` : ''}`
		);
		expect(res.status(), `listing ${location ?? 'alpha'}`).toBe(200);
		return ((await res.json()) as { files: { path: string }[] }).files
			.map((f) => f.path)
			.filter((p) => names.some((n) => p.endsWith(`/${n}`)));
	};
	return { ...linked, names, filesIn };
}

test(
	'right after linking my own bucket, Alpha offers to save new files there and to copy my two files, and afterwards they are in both places and the bucket is the default',
	{ tag: ['@preview-only', '@A3', '@CUR-2941', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		const { folder, locationId, names, filesIn } = await linkedWithTwoAlphaFiles(
			page,
			context,
			baseURL!,
			token!
		);
		try {
			const offer = page.getByTestId('storage-move-offer');
			await expect(offer, 'linking a bucket offered nothing').toBeVisible({ timeout: 30_000 });
			const saveThere = offer.getByRole('checkbox', { name: /Save new files there/ });
			const copyMine = offer.getByRole('checkbox', { name: /Also copy my 2 files/ });
			await expect(saveThere).toBeChecked();
			await expect(copyMine, 'copying existing files must be opt-in').not.toBeChecked();
			await copyMine.check();
			await offer.getByRole('button', { name: 'Continue' }).click();

			await expect(offer).toContainText('Both files are copied', { timeout: 60_000 });
			// Copy only: nothing offers to delete, and Alpha storage keeps both files for old chats.
			await expect(offer.getByRole('button', { name: /Delete/ })).toHaveCount(0);
			expect(await filesIn(), 'a copied file left Alpha storage').toHaveLength(2);
			expect((await filesIn(locationId)).sort(), 'a copied file is not in the bucket').toEqual(
				names.map((n) => `${folder}/documents/${n}`).sort()
			);
			const state = (await (await page.request.get('/chat/api/storage/locations')).json()) as {
				defaultLocation: string;
			};
			expect(state.defaultLocation, 'the new bucket is not the default').toBe(locationId);
		} finally {
			for (const n of names) await deleteBucketFile(token!, `${folder}/documents/${n}`);
			await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

test(
	'when the second file fails its check during the copy, every file is still in Alpha storage and Retry resumes from that file',
	{ tag: ['@preview-only', '@A3', '@CUR-2941', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		const { folder, locationId, names, filesIn } = await linkedWithTwoAlphaFiles(
			page,
			context,
			baseURL!,
			token!
		);
		try {
			// The first copy goes through for real; the second answers as the server does when the copy
			// it wrote does not match what it read. A third call, the retry, goes through.
			let calls = 0;
			await page.route('**/chat/api/storage/transfer', async (route) => {
				calls += 1;
				if (calls !== 2) return route.continue();
				return route.fulfill({
					status: 502,
					contentType: 'application/json',
					body: JSON.stringify({ message: "The copy didn't match the original." })
				});
			});
			const offer = page.getByTestId('storage-move-offer');
			await expect(offer, 'linking a bucket offered nothing').toBeVisible({ timeout: 30_000 });
			await offer.getByRole('checkbox', { name: /Also copy my 2 files/ }).check();
			await offer.getByRole('button', { name: 'Continue' }).click();

			await expect(offer.getByRole('alert')).toContainText('Nothing in Alpha storage changed', {
				timeout: 60_000
			});
			expect(calls, 'the copy went on past the failed file').toBe(2);
			expect(await filesIn(), 'a source file left Alpha storage').toHaveLength(2);

			// Retry picks up at the file that failed rather than copying the first one again.
			await offer.getByRole('button', { name: /^Retry from / }).click();
			await expect(offer).toContainText('Both files are copied', { timeout: 60_000 });
			expect(calls, 'Retry copied the first file again').toBe(3);
			expect(await filesIn(), 'a source file left Alpha storage').toHaveLength(2);
		} finally {
			await page.unroute('**/chat/api/storage/transfer');
			for (const n of names) await deleteBucketFile(token!, `${folder}/documents/${n}`);
			await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);

test(
	'when my bucket already holds a different file with the same name, the copy keeps both, saves mine as name (2), and still finishes',
	{ tag: ['@preview-only', '@A3', '@CUR-2941', '@linked-bucket'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const token = process.env.E2E_LINKED_BUCKET_TOKEN;
		expect(token, 'this test needs E2E_LINKED_BUCKET_TOKEN, scoped to e2e-linked').toBeTruthy();
		const { folder, locationId, names, filesIn } = await linkedWithTwoAlphaFiles(
			page,
			context,
			baseURL!,
			token!
		);
		const taken = `${folder}/documents/${names[0]}`;
		const renamed = `${folder}/documents/${names[0].replace('.txt', ' (2).txt')}`;
		try {
			// Something already sits under the first file's name, with other bytes in it.
			const { uploadFile } = await import('@huggingface/hub');
			await uploadFile({
				repo: `buckets/${LINKED_BUCKET}`,
				accessToken: token!,
				file: { path: taken, content: new Blob(['already here, not from Alpha\n']) }
			});

			const offer = page.getByTestId('storage-move-offer');
			await expect(offer, 'linking a bucket offered nothing').toBeVisible({ timeout: 30_000 });
			await offer.getByRole('checkbox', { name: /Also copy my 2 files/ }).check();
			await offer.getByRole('button', { name: 'Continue' }).click();

			await expect(offer).toContainText('Both files are copied', { timeout: 60_000 });
			await expect(offer).toContainText(`Copied as ${names[0].replace('.txt', ' (2).txt')}`);
			expect(await filesIn(), 'a file left Alpha storage').toHaveLength(2);
			// filesIn keeps only the two original names, so a renamed copy needs the whole listing.
			const listed = await page.request.get(`/chat/api/storage?location=${locationId}`);
			const inBucket = ((await listed.json()) as { files: { path: string }[] }).files.map(
				(f) => f.path
			);
			expect(inBucket, 'the file already in the bucket was overwritten or lost').toContain(taken);
			expect(inBucket, 'my copy was not kept under a free name').toContain(renamed);
		} finally {
			for (const p of [taken, renamed, `${folder}/documents/${names[1]}`])
				await deleteBucketFile(token!, p);
			await page.request.delete(`/chat/api/storage/locations/${locationId}`);
		}
	}
);
