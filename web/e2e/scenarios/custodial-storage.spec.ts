// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { listFiles } from '@huggingface/hub';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { journeyStep } from './helpers/journeyStep';
import { faultInjectionHeaders, installFaultInjectionHeader } from './helpers/faultInjection';
import { STORAGE_POLL_INTERVALS } from './helpers/storagePoll';
import { failIfStorageThrottled } from './helpers/storageThrottle';
import { startChattingPastWelcome } from './helpers/welcome';

// The bucket the target deployment writes to; unset means production's, same as the app (CUR-1288).
const BUCKET = process.env.HF_BUCKETS_REPO || 'buckets/current-ai-official/custodial-storage-eu';

/**
 * Uploads one text file through the page's own file input. Retried until the upload request is
 * actually sent: before hydration the input has no change handler yet, and a file set then is
 * silently dropped. Same name each time, so a retry overwrites rather than adding a second file.
 */
async function uploadThroughPage(
	page: Page,
	name: string,
	body: string | Buffer,
	mimeType = 'text/plain'
): Promise<void> {
	await failIfStorageThrottled(page);
	await expect(async () => {
		const uploaded = page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
			{ timeout: 10_000 }
		);
		await page
			.locator('input[type=file]')
			.first()
			.setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
		expect((await uploaded).ok()).toBe(true);
	}).toPass({ timeout: 45_000, intervals: STORAGE_POLL_INTERVALS });
}

/** The account's files as the app lists them — a live `listFiles` against the bucket, not a cache. */
async function appListedPaths(page: Page): Promise<string[]> {
	await failIfStorageThrottled(page);
	const res = await page.request.get('/chat/api/storage');
	expect(res.status(), 'the storage list endpoint did not answer 200').toBe(200);
	return ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path);
}

/** `users/<id>/`, taken from one of the account's own stored paths. */
function userPrefix(path: string): string {
	return path.slice(0, path.indexOf('/', 'users/'.length) + 1);
}

/**
 * Files under the prefix read straight from the bucket with HF_BUCKETS_TOKEN, bypassing the app.
 * Null when the run does not hold the token, which CI does not (scenario-suite-check.yml reads only
 * the database URL, the OTP bypass and BETTER_AUTH_SECRET).
 */
async function bucketFilesUnder(prefix: string): Promise<string[] | null> {
	const token = process.env.HF_BUCKETS_TOKEN;
	if (!token) return null;
	// A 429 is the shared token's 3,000-calls-per-5-minutes cap, which says nothing about the bucket.
	// Waiting it out spends the next window alongside every other waiting shard (CUR-3680), so fail
	// at once and name it, as failIfStorageThrottled does for the storage routes. Any other error
	// fails as itself.
	try {
		const left: string[] = [];
		for await (const e of listFiles({
			repo: BUCKET,
			path: prefix,
			recursive: true,
			accessToken: token
		})) {
			if (e.type === 'file' && !e.path.startsWith(`${prefix}quarantine/`)) left.push(e.path);
		}
		return left;
	} catch (err) {
		if ((err as { statusCode?: number }).statusCode === 429) {
			throw new Error(
				'Hugging Face is throttling the shared storage token (429 on the bucket listing): infrastructure, not this change',
				{ cause: err }
			);
		}
		throw err;
	}
}

/**
 * Deletes whatever the signed-in account still holds, through the same endpoint the Delete button
 * calls. Runs from a `finally`, so it never throws: a cleanup failure is annotated rather than
 * allowed to replace the assertion that actually failed.
 */
async function removeLeftovers(page: Page): Promise<void> {
	try {
		const paths = await appListedPaths(page);
		for (const path of paths) {
			await page.request.delete(`/chat/api/storage/file?path=${encodeURIComponent(path)}`);
		}
		const after = await appListedPaths(page);
		test.info().annotations.push({
			type: 'cleanup',
			description: after.length
				? `left ${after.length} file(s) after cleanup: ${after.join(', ')}`
				: `removed ${paths.length} leftover file(s)`
		});
	} catch (err) {
		test
			.info()
			.annotations.push({ type: 'cleanup', description: `cleanup failed: ${String(err)}` });
	}
}

// A3 step 7 — "the storage view for a person's own files". CUR-899 is the epic line; CUR-415 covers
// the words a person reads once they get there and is still open on its own question, so the first
// test here walks reachability and says nothing about the copy. The second checks one factual claim
// in it: where the files are kept.
//
// WHAT IT ASSERTS IS THE COUPLING, NOT THE FLAG STATE. `custodial-storage-view` is evaluated
// per-account rather than per-deployment, so a scenario run cannot reliably force it in both
// directions the way data-portability.spec.ts forces `data-export` (CUR-1664 is the same override
// gap on the per-user path). Pinning an expected state would make this spec a report on whichever
// way the live flag happened to fall.
//
// So it pins the invariant instead, and the invariant is the defect this journey exists to prevent:
// the settings nav tab and the page behind it read THE SAME GATE, so a visible control always leads
// somewhere that renders and an absent one never hides a page a person could still reach by URL.
// It goes red for that failure in both directions and needs no control over the flag to do it.
test(
	'the storage tab and the storage page agree, so a visible control never leads to a 404',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await signInAsFreshUser(page);

		await page.goto('/chat/settings', { waitUntil: 'commit' });
		await page.waitForURL(/\/settings/, { timeout: 30_000 });

		// The nav entry, by its own accessible name rather than its label text — the label is free to
		// be rewritten, the promise it makes to a screen-reader user is not.
		const tab = page.getByRole('link', {
			name: 'How much storage you use, where new files go, and linked buckets'
		});
		await expect(page.getByRole('link', { name: /account/i }).first()).toBeVisible({
			timeout: 30_000
		});
		const tabVisible = await tab.isVisible();

		// Both storage pages: the settings inside the settings pane, where this tab leads (CUR-1769,
		// CUR-4363), and the files at /chat/storage, where the chat rail's Files entry leads. One gate
		// covers both.
		for (const path of ['/chat/settings/storage', '/chat/storage']) {
			const status = (await page.request.get(path)).status();
			if (tabVisible) {
				expect(
					status,
					`the settings nav offers a Storage tab and ${path} answered ${status}. A person who clicks a control we rendered for them lands on nothing, which is the one outcome gating the tab on the same read was meant to make impossible`
				).toBe(200);
			} else {
				expect(
					status,
					`the settings nav withholds the Storage tab, but ${path} answered ${status}, so the page is reachable by URL while the product pretends it is not. A gate that only hides the door is not a gate`
				).toBe(404);
			}
		}

		// Recorded either way: a reader of a green run should be able to tell WHICH of the two
		// consistent states this deployment was in, since only one of them is a demo.
		test.info().annotations.push({
			type: 'custodial storage',
			description: tabVisible ? 'tab shown, page renders' : 'tab withheld, page 404s'
		});

		test.skip(
			!tabVisible,
			'this account is not inside custodial-storage-view, so there is no view to walk (CUR-1682)'
		);

		// Click the tab a person can see, and land on a page
		// that has rendered rather than on an error boundary.
		await tab.click();
		// The tab switches the settings pane like its siblings. It used to link out to
		// /chat/storage, which left settings with no way back but the browser's.
		await expect(page).toHaveURL(/\/chat\/settings\/storage$/, { timeout: 15_000 });
		await expect(
			tab,
			'the Storage tab is not marked as the open section, so the settings nav no longer says where the person is'
		).toHaveAttribute('aria-current', 'page');
		await expect(
			page.getByRole('link', { name: /account/i }).first(),
			'the settings nav is gone after opening Storage, so the tab still acts as an exit from settings'
		).toBeVisible();

		// THE PAGE'S OWN HEADINGS, not a `main` landmark: a `main` locator tests landmark structure on a
		// page that rendered perfectly, while claiming to test whether the tab leads somewhere.
		// The tab leads to the storage settings, and those link to the files.
		await expect(
			page.getByRole('heading', { name: 'Usage', level: 2 }),
			'the storage settings route answered 200 but never rendered its usage section, so the tab leads to a blank screen'
		).toBeVisible({ timeout: 20_000 });
		await page.getByRole('link', { name: 'Open your files' }).click();
		await expect(page).toHaveURL(/\/chat\/storage$/, { timeout: 15_000 });
		await expect(
			page.getByRole('heading', { name: 'Your files', level: 1 }),
			"Open your files answered but never rendered its own heading, so the link leads to a blank screen rather than to a person's files"
		).toBeVisible({ timeout: 20_000 });
	}
);

// A3 "delete my data": deleting the account left the person's upload
// in the bucket, the done panel never mentioned files, and signing back in showed "No files yet", so
// the orphan could never be reached again. This walks upload -> delete account -> the done panel
// names the file, and, when the run holds HF_BUCKETS_TOKEN, lists the bucket prefix directly to prove
// the file is gone. Without the token the done panel's count is the evidence, and the run says so.
test(
	'deleting the account deletes the files the person uploaded, and the done panel says how many',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);

		// Where the files actually are: a Hugging Face bucket Current AI holds. The panel used to say
		// they "stay inside Alpha", which no part of the storage path does. Since CUR-4363 Settings →
		// Storage says it; the files page links there.
		await page.goto('/chat/settings/storage', { waitUntil: 'commit' });
		const whereKept = page.getByTestId('storage-where-kept');
		await expect(
			whereKept,
			'the storage page does not say the files are stored with Hugging Face'
		).toContainText('stored with Hugging Face', { timeout: 30_000 });
		await expect(whereKept).not.toContainText(/stay inside Alpha/i);
		// The sentence used to name "Current AI" with no word of who that is, and the A3
		// grader flagged it twice. It now says who holds the storage.
		await expect(
			whereKept,
			'the storage page names Current AI without saying who it is'
		).toContainText('held by Current AI, the nonprofit that runs Alpha');
		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		const name = 'board-meeting-agenda.txt';
		const content = 'Board meeting agenda\n1. Donor list review\n';
		let accountDeleted = false;
		try {
			await journeyStep(page, 'A3', 7, async () => {
				await uploadThroughPage(page, name, content);
				await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
					timeout: 30_000
				});
				// The usage meter counts what was just stored, against the quota it names. With
				// CUSTODIAL_SEAL_WRITES on, what is stored is the age file (CUR-4116), about 1.7 KB for this
				// 43-byte text, so the size may read in B or KB.
				const meter = page.getByRole('meter', { name: '1 file' });
				await expect(meter, 'the usage meter did not count the uploaded file').toHaveAttribute(
					'aria-valuetext',
					/^\d+(\.\d+)? K?B of 250(\.0)? MB$/
				);
				await expect(page.getByTestId('storage-warning')).toHaveCount(0);

				// The download button has to hand the person their file back: the page's URL changed to the file
				// endpoint and nothing was saved (CUR-1861). Hard assertions: the `finally` below removes the file if
				// any of them fails, so orphan protection no longer depends on these being soft (CUR-2033).
				const downloaded = await Promise.all([
					page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
					page.getByRole('button', { name: `Download ${name}` }).click()
				]).then(([d]) => d);
				expect(downloaded, 'clicking Download did not download anything').not.toBeNull();
				expect(
					readFileSync((await downloaded!.path())!, 'utf8'),
					'the downloaded file is not the one that was uploaded'
				).toBe(content);
				expect(
					new URL(page.url()).pathname,
					'clicking Download navigated the page away from the file list'
				).toBe('/chat/storage');
			});

			// The account's own prefix, read back from the app before the account stops existing.
			const stored = (await appListedPaths(page)).find((p) => p.endsWith(`/${name}`));
			expect(
				stored,
				'the upload never reached the bucket, so there is nothing to delete'
			).toBeTruthy();
			const prefix = userPrefix(stored!);

			await journeyStep(page, 'A3', 12, async () => {
				await page.goto('/chat/settings/account', { waitUntil: 'commit' });
				await page
					.getByRole('button', { name: 'Delete your account, conversations, and sign-in methods' })
					.click({ timeout: 30_000 });
				// Deleting an account takes a typed word before the button enables (CUR-1420).
				await page.getByLabel('Type DELETE to confirm').fill('DELETE');
				await page.getByRole('button', { name: 'Delete account', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible(
					{
						timeout: 60_000
					}
				);
				accountDeleted = true;
				await expect(
					page.getByText('1 uploaded file', { exact: true }),
					'the account wipe did not report deleting the uploaded file, so it either left it in the bucket or deleted it without telling the person'
				).toBeVisible();
			});

			const left = await bucketFilesUnder(prefix);
			if (left)
				expect(left, `files still under ${prefix} after the account was deleted`).toEqual([]);
			test.info().annotations.push({
				type: 'bucket check',
				description: left
					? `listed ${prefix} directly: empty`
					: 'HF_BUCKETS_TOKEN not set for this run; the done panel count is the evidence'
			});
		} finally {
			if (!accountDeleted) await removeLeftovers(page);
		}
	}
);

// A3 "delete my data", one file at a time. The row's Delete button is the only way a person removes
// a single upload, and until CUR-2033 no test pressed it. It goes red if the row stays, if the app
// still lists the file afterwards (a live read of the bucket), or, when the run holds
// HF_BUCKETS_TOKEN, if the bucket itself still has it.
test(
	'deleting one file from the storage view removes it from the list and from the bucket',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);

		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		const name = 'grant-draft-notes.txt';
		try {
			await journeyStep(page, 'A3', 7, async () => {
				await uploadThroughPage(page, name, 'Grant draft notes\n- budget table\n');
				const del = page.getByRole('button', { name: `Delete ${name}` });
				await expect(del).toBeVisible({ timeout: 30_000 });

				const stored = (await appListedPaths(page)).find((p) => p.endsWith(`/${name}`));
				expect(
					stored,
					'the upload never reached the bucket, so there is nothing to delete'
				).toBeTruthy();

				await del.click();
				const dialog = page.getByRole('dialog', { name: 'Delete this file?' });
				await expect(dialog).toBeVisible();
				const deleted = page.waitForResponse(
					(r) => r.request().method() === 'DELETE' && r.url().includes('/chat/api/storage/file'),
					{ timeout: 20_000 }
				);
				await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
				expect((await deleted).status(), 'the delete request was refused').toBe(200);

				await expect(
					page.getByRole('button', { name: `Delete ${name}` }),
					'the file is still in the list after its Delete was confirmed'
				).toHaveCount(0, { timeout: 15_000 });

				expect(
					await appListedPaths(page),
					'the row disappeared but the app still lists the file, so the bucket kept it'
				).not.toContain(stored);

				const left = await bucketFilesUnder(userPrefix(stored!));
				if (left)
					expect(left, `${stored} is still in the bucket after Delete`).not.toContain(stored);
				test.info().annotations.push({
					type: 'bucket check',
					description: left
						? `listed the prefix directly: ${stored} gone`
						: 'HF_BUCKETS_TOKEN not set for this run; the app listing (a live bucket read) is the evidence'
				});
			});
		} finally {
			await removeLeftovers(page);
		}
	}
);

// CUR-3289 slice 2: My files shows an image as a thumbnail and opens a file in place. The file
// endpoint always answers as a download (storage/file/+server.ts), so a row that opened by navigating
// to it would save the file instead; the download listener is what tells the two apart.
test(
	'My files shows an image as a thumbnail and opens a row in place without downloading it',
	{ tag: ['@preview-only', '@A3', '@CUR-3289'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);
		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		const image = 'gradient-48x32.png';
		const pdf = 'expenses-policy.pdf';
		const downloads: string[] = [];
		page.on('download', (d) => downloads.push(d.suggestedFilename()));
		try {
			await uploadThroughPage(
				page,
				image,
				readFileSync(new URL('./fixtures/gradient-48x32.png', import.meta.url)),
				'image/png'
			);
			await uploadThroughPage(
				page,
				pdf,
				readFileSync(new URL('./fixtures/expenses-policy.pdf', import.meta.url)),
				'application/pdf'
			);

			const imageRow = page.locator('[data-file-row]').filter({ hasText: image });
			const pdfRow = page.locator('[data-file-row]').filter({ hasText: pdf });
			const thumb = imageRow.locator('img[data-file-thumbnail]');
			await expect(thumb, 'the image row shows no thumbnail').toBeVisible({ timeout: 30_000 });
			expect(
				await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth),
				'the thumbnail is an <img> whose bytes did not decode as the uploaded image'
			).toBe(48);
			await expect(
				pdfRow.locator('[data-file-kind="pdf"]'),
				'the PDF row has no PDF icon'
			).toBeVisible();
			for (const row of [imageRow, pdfRow]) {
				await expect(
					row.getByText(/^Added .*\d{4}/),
					'a row does not say when it was added'
				).toBeVisible();
			}

			await imageRow.getByRole('button', { name: `Open ${image}` }).click();
			const preview = page.getByTestId('file-preview');
			await expect(
				preview.getByRole('img', { name: image }),
				'opening the image row did not show the image in place'
			).toBeVisible({ timeout: 20_000 });
			await page.keyboard.press('Escape');
			await expect(preview).toBeHidden();

			await pdfRow.getByRole('button', { name: `Open ${pdf}` }).click();
			await expect(preview.getByRole('heading', { name: pdf })).toBeVisible({ timeout: 20_000 });
			await page.keyboard.press('Escape');

			expect(downloads, 'opening a row started a download instead of a preview').toEqual([]);
		} finally {
			await removeLeftovers(page);
		}
	}
);

/** The rota's text; an attachment's download path is the sha256 of it. */
const ROTA_TEXT = 'Volunteer rota\nSaturday: bake the bread\nSunday: wash the cups\n';

/**
 * Drops the volunteer rota onto the composer and waits until it shows as attached. Dragged, the way
 * a person attaches today: the paperclip is switched off (`ChatInput.svelte`'s `showFileUpload`), and
 * dropping a file is the path the chat still offers. Saturday and Sunday are both answerable only
 * from the file. Returns the composer.
 */
async function dropRotaOnComposer(page: Page, name: string) {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	const dataTransfer = await page.evaluateHandle(
		({ fileName, text }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([text], fileName, { type: 'text/plain' }));
			return dt;
		},
		{ fileName: name, text: ROTA_TEXT }
	);
	await page.getByRole('form', { name: 'file dropzone' }).dispatchEvent('dragenter', {
		dataTransfer
	});
	const dropzone = page.getByText('Drop files to attach');
	await expect(dropzone).toBeVisible({ timeout: 10_000 });
	await dropzone.dispatchEvent('drop', { dataTransfer });
	await expect(
		page.getByText(name).first(),
		'the dropped file never showed as attached in the composer'
	).toBeVisible({ timeout: 10_000 });
	return composer;
}

// A3 "work on my own documents" (CUR-2172): a file attached in a chat is one the person gave Alpha,
// so it belongs in My files too, where they can find it, delete it and export it. Until this, only
// files uploaded on the storage page reached the bucket. It attaches through the composer's own
// input, sends, and reads the list back from the app: red if the file never lands, or lands
// anywhere but under the conversation it was attached to.
test(
	'a file attached in chat lands in My files under its conversation, dated and linked back to it, reaches a later turn, and goes when the conversation is deleted',
	{ tag: ['@preview-only', '@A3', '@CUR-3289'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const name = 'volunteer-rota.txt';
		try {
			const composer = await dropRotaOnComposer(page, name);
			await composer.fill('What is on the rota for Saturday?');
			const posted = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' &&
					/\/chat\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
				{ timeout: 60_000 }
			);
			await composer.press('Enter');

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
			const conversationId = new URL(page.url()).pathname.split('/').pop()!;
			expect((await posted).ok(), 'the message POST was refused').toBe(true);
			// The message POST's response is not the moment the attachment is stored: with the client's
			// x-prestream-events opt-in the route sends headers first and stores inside the stream, so a
			// read on that response raced the write. The write is awaited before
			// generation starts, so once the first answer has finished the file must be listed.
			const first = page.locator('[data-message-role="assistant"]').first();
			await expect(turnDone(first), 'the first turn never finished').toBeVisible({
				timeout: 90_000
			});

			// The bucket is the attachment's only store, so the file is listed by the end of the
			// turn that used it. One read, no poll. This cannot tell an awaited write from a background
			// copy that finished inside the turn; the server's `[storage] chat attachments stored` line
			// (toTable 0) is the evidence for that.
			const stored = (await appListedPaths(page)).find((p) => p.endsWith(`/${name}`));
			expect(stored, `${name} was not in My files after the turn that used it`).toBeTruthy();
			expect(
				stored,
				'the attachment reached My files but not under the conversation that used it'
			).toContain(`/conversations/${conversationId}/`);

			// CUR-3289, A3 step 29: from the chat, through the sidebar's Files, open the file in place and
			// follow its row back to the chat it came from. The gallery films this row.
			await journeyStep(page, 'A3', 29, async () => {
				const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
				if (await openSidebar.isVisible()) await openSidebar.click();
				await page.getByRole('link', { name: 'Files', exact: true }).click();
				await page.waitForURL(/\/chat\/storage$/, { timeout: 30_000 });
				await expect(
					page.getByRole('button', { name: `Delete ${name}` }),
					'the storage page does not list the file attached in chat'
				).toBeVisible({ timeout: 30_000 });

				// A row says when the file was added and links back to the chat it came from, so
				// four copies of one photo can be told apart and each found again.
				const row = page.locator('[data-file-row]').filter({ hasText: name });
				await expect(
					row.getByText(/^Added .*\d{4}/),
					'the row for a file attached in chat does not say when it was added'
				).toBeVisible();

				await row.getByRole('button', { name: `Open ${name}` }).click();
				const preview = page.getByTestId('file-preview');
				await expect(
					preview,
					'opening the attached rota did not show its text in place'
				).toContainText('Saturday: bake the bread', { timeout: 20_000 });
				await page.keyboard.press('Escape');
				await expect(preview).toBeHidden();

				const fromChat = row.getByRole('link', { name: `Open the chat ${name} came from` });
				await expect(
					fromChat,
					'the row for a file attached in chat does not link to that chat'
				).toHaveAttribute('href', new RegExp(`/chat/conversation/${conversationId}$`));
				await fromChat.click();
				await page.waitForURL(new RegExp(`/chat/conversation/${conversationId}$`), {
					timeout: 30_000
				});
			});

			// A later turn still reads the attachment, now from this copy first. The question
			// is answerable only from the file, so an answer naming the cups shows the file reached turn two.
			await page.goto(`/chat/conversation/${conversationId}`, { waitUntil: 'commit' });
			const answers = page.locator('[data-message-role="assistant"]');
			await expect(answers.first()).toBeVisible({ timeout: 30_000 });
			await composer.fill('And what is on the rota for Sunday?');
			await composer.press('Enter');
			await expect(answers, 'the second turn never produced an answer').toHaveCount(2, {
				timeout: 60_000
			});
			const second = answers.last();
			await expect(turnDone(second), 'the second turn never finished').toBeVisible({
				timeout: 90_000
			});
			await expect(
				second,
				'the second turn answered without the attached rota, so the attachment never reached it'
			).toContainText(/cups/i);

			// Deleting the conversation deletes its attachments from My files with it.
			const open = page.getByRole('button', { name: 'Open sidebar' });
			if (await open.isVisible()) await open.click();
			const link = page.locator(`a[href$="/conversation/${conversationId}"]:visible`);
			await expect(link).toBeVisible({ timeout: 20_000 });
			await link.hover();
			await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
			await page.getByRole('menuitem', { name: 'Delete' }).click();
			const deleted = page.waitForResponse(
				(r) => r.request().method() === 'DELETE' && r.url().includes(conversationId),
				{ timeout: 30_000 }
			);
			await page.getByRole('button', { name: 'Delete', exact: true }).click();
			expect((await deleted).ok(), 'the conversation delete failed').toBe(true);
			// The rail emptied while the deleted chat's transcript stayed on screen under a bare
			// "Conversation" header, so the person could not tell the
			// delete had worked. The two leave together, timed from the moment the rail row goes.
			await expect(link).toHaveCount(0, { timeout: 10_000 });
			const railClearedAt = Date.now();
			page.on('framenavigated', (f) => {
				if (f === page.mainFrame())
					console.log(
						`[CUR-2996] left the conversation ${Date.now() - railClearedAt} ms after the rail`
					);
			});
			await expect(
				page.getByText('And what is on the rota for Sunday?'),
				'the deleted conversation is still on screen after its row left the rail'
			).toHaveCount(0, { timeout: 500 });
			test.info().annotations.push({
				type: 'transcript-after-rail-ms',
				description: String(Date.now() - railClearedAt)
			});
			await expect(page).not.toHaveURL(new RegExp(conversationId));
			await failIfStorageThrottled(page);
			await expect(async () => {
				const left = (await appListedPaths(page)).filter((p) =>
					p.includes(`/conversations/${conversationId}/`)
				);
				expect(left, 'the conversation is gone but its attachment is still in My files').toEqual(
					[]
				);
			}).toPass({ timeout: 30_000, intervals: STORAGE_POLL_INTERVALS });
		} finally {
			await removeLeftovers(page);
		}
	}
);

// The bucket never stalls a turn. A write Hugging Face throttles puts the file in the
// conversation's files table and the turn goes on. The fault answers the store the way the real
// failure does on the live preview, so this goes red if the failure ends the send, the question is
// lost, or the file never reaches the model. A full quota is no longer one of these (CUR-3235, below).
for (const fault of ['storage_hub_rate_limited'] as const) {
	test(
		`an attachment the bucket refuses (${fault}) still reaches the model, through the files table`,
		{ tag: ['@preview-only', '@A3', '@CUR-2183'] },
		async ({ page, context, baseURL }) => {
			test.setTimeout(180_000);
			await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
			await signInAsFreshUser(page);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await installFaultInjectionHeader(page, fault);
			await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

			// The chip cuts a name over 28 characters in the middle (`UploadedFile.svelte`), so keep it short.
			const name = `fallback-${fault === 'storage_quota_full' ? 'quota' : 'busy'}.txt`;
			try {
				const composer = await dropRotaOnComposer(page, name);
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
				expect(
					(await turnStarted).status(),
					'the bucket failure refused the message instead of falling back'
				).toBeLessThan(400);

				await expect(composer, 'the message stayed on the composer instead of sending').toHaveValue(
					'',
					{ timeout: 10_000 }
				);
				await expect(
					page.getByText('Storage is busy right now. Try again in a minute.'),
					'the throttled bucket still showed the old refusal'
				).toHaveCount(0);
				await expect(
					page.getByText(/Your files are full/),
					'the full quota still showed the old refusal'
				).toHaveCount(0);

				// The question is answerable only from the file, so naming the bread shows it reached the model.
				const answer = page.locator('[data-message-role="assistant"]').last();
				await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 90_000 });
				await expect(
					answer,
					'the turn answered without the attached rota, so the fallback lost the file'
				).toContainText(/bread/i, { timeout: 30_000 });
				// The table copy is the only one: a bucket copy would mean the fault never reached the write.
				await failIfStorageThrottled(page);
				await expect(async () => {
					expect(
						(await appListedPaths(page)).filter((p) =>
							p.includes(`/conversations/${conversationId}/`)
						),
						'the fault never reached the bucket write, so this run did not exercise the fallback'
					).toEqual([]);
				}).toPass({ timeout: 30_000, intervals: STORAGE_POLL_INTERVALS });
			} finally {
				await removeLeftovers(page);
			}
		}
	);
}

/** My files' listing, answered as an account already at its 250 MB limit, for the attach-time check. */
async function answerMyFilesAsFull(page: Page) {
	await page.route(
		(url) => url.pathname === '/chat/api/storage',
		async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			await route.fulfill({
				json: { files: [{ path: 'users/full/uploads/archive.bin', size: 250_000_000 }] }
			});
		}
	);
}

// A full My files used to send the attachment to the files table, outside My files and its
// limit. Now the composer asks My files for its headroom when a file is attached and refuses one that
// won't fit, before Send, with the line that says what to do. The listing is answered as full, since a
// fresh account can't be filled to 250 MB in a spec; red if the file still sits on the composer.
test(
	'a file that would take a full My files past its limit is refused when it is attached, before Send',
	{ tag: ['@preview-only', '@A6', '@CUR-3235'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await answerMyFilesAsFull(page);
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const name = 'over-quota.txt';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		const dataTransfer = await page.evaluateHandle((fileName) => {
			const dt = new DataTransfer();
			dt.items.add(
				new File(['Volunteer rota\nSaturday: bake the bread\n'], fileName, { type: 'text/plain' })
			);
			return dt;
		}, name);
		await page
			.getByRole('form', { name: 'file dropzone' })
			.dispatchEvent('dragenter', { dataTransfer });
		const dropzone = page.getByText('Drop files to attach');
		await expect(dropzone).toBeVisible({ timeout: 10_000 });
		await dropzone.dispatchEvent('drop', { dataTransfer });

		await expect(
			page.getByText('Your files are full (250 MB). Delete a file in My files to attach this one.'),
			'a file over the My files limit was taken with no reason shown'
		).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByText(name),
			'the file that cannot fit in My files still sat on the composer, ready to send'
		).toHaveCount(0);
	}
);

// My files' listing is a recursive Hugging Face call on a token every visitor shares, and the
// attach-time check above made one per attach. A roomy headroom read in the last minute is now reused,
// so three files dropped one after another list My files once. The listing is answered here as an empty
// account, so the count is the composer's own requests and no Hub call is spent; red if each drop lists.
test(
	'three files dropped one after another check My files headroom with one listing, not three',
	{ tag: ['@preview-only', '@A6', '@CUR-3681'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		let listings = 0;
		await page.route(
			(url) => url.pathname === '/chat/api/storage',
			async (route) => {
				if (route.request().method() !== 'GET') return route.continue();
				listings += 1;
				await route.fulfill({ json: { files: [] } });
			}
		);
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		listings = 0;

		for (const name of ['rota-1.txt', 'rota-2.txt', 'rota-3.txt']) {
			const dataTransfer = await page.evaluateHandle((fileName) => {
				const dt = new DataTransfer();
				dt.items.add(
					new File([`Volunteer rota for ${fileName}\n`], fileName, { type: 'text/plain' })
				);
				return dt;
			}, name);
			await page
				.getByRole('form', { name: 'file dropzone' })
				.dispatchEvent('dragenter', { dataTransfer });
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone).toBeVisible({ timeout: 10_000 });
			await dropzone.dispatchEvent('drop', { dataTransfer });
			await expect(page.getByText(name), `${name} never reached the composer`).toBeVisible({
				timeout: 15_000
			});
		}
		expect(listings, 'each dropped file listed My files again').toBe(1);
	}
);

// When the quota fills between attaching and sending, the send is refused with a 413 status
// update and the same line. The client drops the file and gives the question back, so nothing is lost and nothing lands in
// the files table. The fault answers the bucket write as a full quota on the live preview.
test(
	'a send that finds My files full is refused with the quota line, keeps the question, and stores the file nowhere',
	{ tag: ['@preview-only', '@A6', '@CUR-3235'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const name = 'fallback-quota.txt';
		const question = 'What is on the rota for Saturday?';
		try {
			// The page reloads the conversation after a refusal, which drops a response body Chromium
			// never kept, so the turn is fetched and fulfilled here to read its status update. This
			// handler sends the request itself, so it carries the fault headers too: a route that
			// fulfills ends the chain, and installFaultInjectionHeader's handler would never run.
			let turnBody = '';
			let faultEcho: string | undefined;
			await page.route(/\/chat\/conversation\/[a-f0-9]+$/, async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch({
					headers: { ...route.request().headers(), ...faultInjectionHeaders('storage_quota_full') }
				});
				faultEcho = response.headers()['x-fault-injected'];
				turnBody = await response.text();
				await route.fulfill({ response, body: turnBody });
			});
			const composer = await dropRotaOnComposer(page, name);
			await composer.fill(question);
			const turn = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' &&
					/\/chat\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
				{ timeout: 60_000 }
			);
			await composer.press('Enter');
			// A refusal inside the turn's setup arrives in-stream on a 200 (CUR-1896), so the 413 is read
			// from the status update in the body, not from the HTTP status.
			await turn;
			expect(faultEcho, 'the full-quota fault never reached the server').toBe('storage_quota_full');
			expect(turnBody, 'a full My files still let the attachment through to the turn').toMatch(
				/"statusCode":413\b/
			);
			await expect(
				page.getByText(
					'Your files are full (250 MB). Delete a file in My files to attach this one.'
				),
				'the quota refusal showed no reason'
			).toBeVisible({ timeout: 15_000 });
			await expect(composer, 'the refused question was lost instead of kept to resend').toHaveValue(
				question
			);
			await expect(page.getByText(name), 'the refused file stayed on the composer').toHaveCount(0);
		} finally {
			await removeLeftovers(page);
		}
	}
);

// Every attachment, whichever store takes it, counts against a rolling 24-hour allowance, so
// a bucket that refuses or stalls no longer turns the files table into storage with no limit. The first
// half sends a real file and reads the allowance back from the server: red if the send went uncounted.
// An account's allowance (100 files) is too large to spend in a spec, so the second half answers the
// allowance as spent and checks the composer refuses the next file with the line that says when it
// frees up. The send-time 413 is parseRequest.spec.ts's.
test(
	'an attached file counts against the 24-hour allowance, and a spent allowance refuses the next file at attach',
	{ tag: ['@preview-only', '@A6', '@CUR-3235'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true,
			'attachment-allowance': true
		});
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const filesLeft = async () => {
			const res = await page.request.get('/chat/api/attachment-allowance');
			expect(res.status(), 'the allowance endpoint did not answer with a count').toBe(200);
			return ((await res.json()) as { files: number }).files;
		};
		try {
			await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
			const before = await filesLeft();

			const composer = await dropRotaOnComposer(page, 'counted-rota.txt');
			await composer.fill('What is on the rota for Saturday?');
			const turn = page.waitForResponse(
				(r) =>
					r.request().method() === 'POST' &&
					/\/chat\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
				{ timeout: 60_000 }
			);
			await composer.press('Enter');
			// The turn's own response streams, and Playwright's finished() on it outlived the 180 s test
			// timeout on preview, so wait for the answer on screen as the other turns here do.
			expect((await turn).ok(), 'the turn carrying the file was refused').toBe(true);
			await expect(
				turnDone(page.locator('[data-message-role="assistant"]').last()),
				'the turn carrying the file never finished'
			).toBeVisible({ timeout: 90_000 });
			await expect
				.poll(filesLeft, {
					message: 'the attached file was never counted against the allowance',
					timeout: 30_000
				})
				.toBe(before - 1);

			// With the switch off nothing is refused, so the endpoint gives the composer nothing
			// to refuse with. Red if turning the flag off in PostHog would leave the limit standing.
			await setFlagOverrides(context, baseURL!, {
				'custodial-storage-view': true,
				'attachment-allowance': false
			});
			const off = await page.request.get('/chat/api/attachment-allowance');
			expect(off.status(), 'the allowance still answered a count with its flag off').toBe(204);

			await page.route(
				(url) => url.pathname === '/chat/api/attachment-allowance',
				(route) =>
					route.fulfill({ json: { files: 0, bytes: 0, guest: false, resetsInMs: 3 * 3_600_000 } })
			);
			const name = 'over-allowance.txt';
			const dataTransfer = await page.evaluateHandle((fileName) => {
				const dt = new DataTransfer();
				dt.items.add(new File(['Sunday: wash the cups\n'], fileName, { type: 'text/plain' }));
				return dt;
			}, name);
			await page
				.getByRole('form', { name: 'file dropzone' })
				.dispatchEvent('dragenter', { dataTransfer });
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone).toBeVisible({ timeout: 10_000 });
			await dropzone.dispatchEvent('drop', { dataTransfer });
			await expect(
				page.getByText(
					"You've attached as many files as Alpha takes in a day. You can attach more in about 3 hours."
				),
				'a file past the spent allowance was taken with no reason shown'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.getByText(name),
				'the file past the allowance still sat on the composer, ready to send'
			).toHaveCount(0);
		} finally {
			await removeLeftovers(page);
		}
	}
);

// The refusal is never the first a person hears of the allowance. Once a fifth or less is
// left, a line under the composer's files says how much and when more frees up. The allowance is
// answered as 22 files left so two drops cross the line: the first leaves 21 and says nothing, the
// second leaves 20 and says so. Removing the files takes the line away with them.
test(
	'the composer says how much of the 24-hour allowance is left once a fifth or less remains',
	{ tag: ['@preview-only', '@A6', '@CUR-3235'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true,
			'attachment-allowance': true
		});
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.route(
			(url) => url.pathname === '/chat/api/attachment-allowance',
			(route) =>
				route.fulfill({
					json: { files: 22, bytes: 200_000_000, guest: false, resetsInMs: 3 * 3_600_000 }
				})
		);
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		const near = page.getByTestId('attachment-allowance-near');

		await dropRotaOnComposer(page, 'first-rota.txt');
		await expect(
			near,
			'the near-limit line showed with more than a fifth of the allowance left'
		).toHaveCount(0);

		await dropRotaOnComposer(page, 'second-rota.txt');
		await expect(
			page.getByRole('button', { name: 'Remove first-rota.txt', exact: true }),
			'the second drop took the first file off the composer instead of adding to it'
		).toBeVisible();
		await expect(near, 'twenty files left of a hundred, and the composer said nothing').toHaveText(
			/You can attach 20 more files today, up to .+\. More frees up in about 3 hours\./,
			{ timeout: 10_000 }
		);

		await page.getByRole('button', { name: 'Remove second-rota.txt', exact: true }).click();
		await page.getByRole('button', { name: 'Remove first-rota.txt', exact: true }).click();
		await expect(near, 'the line stayed after every file it described was removed').toHaveCount(0);
	}
);

// A file the bucket stored, read back while Hugging Face throttles the token. It has no row in
// the files table, so the turn used to answer without it and say nothing. The fault throttles the read
// only, so the write lands; this goes red if the turn stays silent about the file it never read. It runs
// on the real screen: the guard once counted the unread file as an unscreened unit and declined the
// whole turn for child safety, which the stub screen never showed.
test(
	'a stored attachment the bucket will not read back is named on the turn, and its download answers busy, never 500',
	{ tag: ['@preview-only', '@A3', '@CUR-3291', '@CUR-3680', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'storage_hub_read_rate_limited');
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const name = 'unread-rota.txt';
		try {
			const composer = await dropRotaOnComposer(page, name);
			await composer.fill('What is on the rota for Saturday?');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
			const conversationId = new URL(page.url()).pathname.split('/').pop()!;

			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(turnDone(answer), 'the turn never finished').toBeVisible({ timeout: 90_000 });
			await expect(
				answer.getByText(`Couldn't read "${name}" from storage just now`),
				'the turn answered without the file and did not say so'
			).toBeVisible({ timeout: 15_000 });
			// The bucket holds the copy: without it this run would be the missing-file case, not a failed read.
			await failIfStorageThrottled(page);
			await expect(async () => {
				expect(
					(await appListedPaths(page)).some((p) => p.includes(`/conversations/${conversationId}/`)),
					'the write never reached the bucket, so this run did not exercise the read'
				).toBe(true);
			}).toPass({ timeout: 30_000, intervals: STORAGE_POLL_INTERVALS });

			// The same file's download link, read while the bucket is throttled, answers busy
			// with a wait rather than a 500. Read once without the fault first, so a 404 can't pass for busy.
			const output = `/chat/conversation/${conversationId}/output/${createHash('sha256').update(ROTA_TEXT).digest('hex')}`;
			expect(
				(await page.request.get(output)).status(),
				'the stored file did not download unthrottled, so the busy answer below would prove nothing'
			).toBe(200);
			const busy = await page.request.get(output, {
				headers: faultInjectionHeaders('storage_hub_read_rate_limited')
			});
			expect(busy.status(), 'a throttled download of a stored attachment did not answer busy').toBe(
				503
			);
			expect(
				Number(busy.headers()['retry-after']),
				'the busy download carried no Retry-After'
			).toBeGreaterThan(0);
			expect((await busy.json()).message).toBe('Storage is busy right now. Try again in a minute.');

			await page.reload({ waitUntil: 'load' });
			await expect(
				page.getByText(`Couldn't read "${name}" from storage just now`),
				'the note did not survive a reload'
			).toBeVisible({ timeout: 30_000 });
		} finally {
			await removeLeftovers(page);
		}
	}
);

// The unread-file note tells the person to ask again once storage recovers. This lifts the
// read fault and asks again in the same chat; it goes red if the stored file stays out of the turn
// after the bucket reads normally, so the advice would be wrong.
test(
	'asking again after the bucket read recovers gets an answer that uses the stored file',
	{ tag: ['@preview-only', '@A3', '@CUR-3291', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const fault = await installFaultInjectionHeader(page, 'storage_hub_read_rate_limited');
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const name = 'retry-rota.txt';
		try {
			const composer = await dropRotaOnComposer(page, name);
			await composer.fill('What is on the rota for Saturday?');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 60_000 });

			const first = page.locator('[data-message-role="assistant"]').last();
			await expect(turnDone(first), 'the first turn never finished').toBeVisible({
				timeout: 90_000
			});
			await expect(
				first.getByText(`Couldn't read "${name}" from storage just now`),
				'the throttled read did not name the file, so the retry below proves nothing'
			).toBeVisible({ timeout: 15_000 });
			await failIfStorageThrottled(page);

			fault.disarm();
			const again = page.getByLabel('Message AI Potluck');
			await again.fill('Storage should be back now. What does the attached rota say for Saturday?');
			await again.press('Enter');

			const second = page.locator('[data-message-role="assistant"]').nth(1);
			await expect(turnDone(second), 'the second turn never finished').toBeVisible({
				timeout: 90_000
			});
			await expect(
				second.getByText(`Couldn't read "${name}" from storage just now`),
				'the bucket read normally and the turn still said it could not read the file'
			).toHaveCount(0);
			await expect(
				second,
				'the answer after storage recovered did not use the rota (Saturday: bake the bread)'
			).toContainText(/bread/i, { timeout: 15_000 });
		} finally {
			await removeLeftovers(page);
		}
	}
);

// Two chats can each hold a file with the same name (the LT demo uploads shapes.png every
// run). The list keyed rows by name, so a second shapes.png gave two rows one key and Svelte
// rendered nothing at all. The two folders the upload endpoint accepts put one name at two paths,
// which is the same shape without driving two chat turns.
test(
	'two stored files with the same name both list, each downloads its own file, and each deletes on its own',
	{ tag: ['@preview-only', '@A3', '@CUR-3198'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'custodial-storage-view': true
		});
		await signInAsFreshUser(page);

		const name = 'shapes-twice.txt';
		try {
			// Uploaded from /chat with the browser's own fetch, so the request carries the page's
			// origin and session the way the Files page's uploader does.
			await page.goto('/chat', { waitUntil: 'domcontentloaded' });
			for (const [folder, body] of [
				['documents', 'short\n'],
				['conversations', 'a longer second body\n']
			] as const) {
				const status = await page.evaluate(
					async ({ folder, body, name }) => {
						const form = new FormData();
						form.set('folder', folder);
						form.set('file', new File([body], name, { type: 'text/plain' }));
						return (await fetch('/chat/api/storage', { method: 'POST', body: form })).status;
					},
					{ folder, body, name }
				);
				expect(status, `uploading ${name} into ${folder}/ was refused`).toBe(201);
			}
			const both = (await appListedPaths(page)).filter((p) => p.endsWith(`/${name}`));
			expect(
				both,
				'the account does not hold two files with one name, so the case never arose'
			).toHaveLength(2);

			await page.goto('/chat/storage', { waitUntil: 'commit' });
			await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			const deletes = page.getByRole('button', { name: `Delete ${name}` });
			await expect(
				deletes,
				'the Files list does not show both same-named files; with name-keyed rows it renders nothing at all'
			).toHaveCount(2, { timeout: 30_000 });

			// Download, copy and delete looked the path up by name too, so once both rows rendered they
			// would all act on whichever same-named file was mapped last. Each row has to hand back its
			// own body.
			const downloads = page.getByRole('button', { name: `Download ${name}` });
			const downloadRow = async (i: number) => {
				const [d] = await Promise.all([
					page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
					downloads.nth(i).click()
				]);
				expect(d, `clicking Download on row ${i + 1} downloaded nothing`).not.toBeNull();
				return readFileSync((await d!.path())!, 'utf8');
			};
			const bodies = [await downloadRow(0), await downloadRow(1)];
			expect(
				[...bodies].sort(),
				'the two same-named rows did not download the two different files'
			).toEqual(['a longer second body\n', 'short\n']);

			await deletes.first().click();
			await page.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(
				deletes,
				'deleting one same-named file did not leave exactly the other'
			).toHaveCount(1, {
				timeout: 30_000
			});
			const left = (await appListedPaths(page)).filter((p) => p.endsWith(`/${name}`));
			expect(
				left,
				'the bucket does not hold exactly one of the two files after one delete'
			).toHaveLength(1);
			expect(both, 'the file left behind is not one of the two uploaded').toContain(left[0]);
			expect(
				await downloadRow(0),
				'the row left after deleting the first one does not download the second file'
			).toBe(bodies[1]);

			await deletes.first().click();
			await page.getByRole('button', { name: 'Delete', exact: true }).click();
			await expect(deletes, 'the second same-named file did not delete').toHaveCount(0, {
				timeout: 30_000
			});
			expect(
				(await appListedPaths(page)).filter((p) => p.endsWith(`/${name}`)),
				'the bucket still holds a same-named file after both were deleted'
			).toHaveLength(0);
		} finally {
			await removeLeftovers(page);
		}
	}
);

// Forget everything destroyed the account's file key (CUR-4117's tombstone, meant for account
// deletion) and kept the account, so every later upload failed for good. This walks upload -> Forget
// everything -> upload again: the second upload must store and hand back the same bytes.
test(
	'after Forget everything the same account can upload a file and download it again',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);

		try {
			await page.goto('/chat/storage', { waitUntil: 'commit' });
			await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			await uploadThroughPage(page, 'before-forgetting.txt', 'kept until I forget it\n');
			await expect(page.getByRole('button', { name: 'Delete before-forgetting.txt' })).toBeVisible({
				timeout: 30_000
			});

			await page.goto('/chat/settings/data', { waitUntil: 'commit' });
			await page.getByRole('button', { name: /^Forget everything/ }).click({ timeout: 30_000 });
			await page.getByRole('button', { name: 'Forget everything', exact: true }).click();
			await expect(page.getByRole('heading', { name: 'Your data has been cleared' })).toBeVisible({
				timeout: 30_000
			});
			expect(
				(await appListedPaths(page)).filter((p) => p.endsWith('/before-forgetting.txt')),
				'Forget everything left the first upload stored'
			).toEqual([]);

			const name = 'after-forgetting.txt';
			const content = 'uploaded after Forget everything\n';
			await page.goto('/chat/storage', { waitUntil: 'commit' });
			await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
				timeout: 30_000
			});
			await uploadThroughPage(page, name, content);
			await expect(
				page.getByRole('button', { name: `Delete ${name}` }),
				'the upload after Forget everything never appeared in the file list'
			).toBeVisible({ timeout: 30_000 });
			const downloaded = await Promise.all([
				page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
				page.getByRole('button', { name: `Download ${name}` }).click()
			]).then(([d]) => d);
			expect(downloaded, 'clicking Download did not download anything').not.toBeNull();
			expect(
				readFileSync((await downloaded!.path())!, 'utf8'),
				'the file uploaded after Forget everything did not come back as uploaded'
			).toBe(content);
		} finally {
			await removeLeftovers(page);
		}
	}
);
