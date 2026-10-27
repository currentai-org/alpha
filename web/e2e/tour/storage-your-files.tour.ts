import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
	setupRecast,
	narrate,
	click,
	zoom,
	highlight,
	waitForNarration
} from 'playwright-recast/helpers';
import { openHome, clickIntoChat, TOUR_RECAST } from './show';
import { signInWithEmailOtp } from '../scenarios/helpers/signIn';

// The STORAGE walkthrough: Your files. One person signs in, opens Files from the chat rail, uploads
// a file, downloads it back, and deletes it. The rail's Files entry shows only where
// `custodial-storage-view` selects the account, which on develop includes the @example.org team
// accounts; a take that stops at the rail means the flag no longer does.
//
// It is filmed for people. custodial-storage.spec.ts holds the assertions; the expects here are
// only the ones a viewer would notice going wrong.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const EMAIL = `jo.lindqvist.${Math.random().toString(36).slice(2, 7)}@example.org`;
const NAME = 'trip-notes.txt';
const CONTENT = 'Trip notes\nTrain to Lucerne 08:12, back 18:40.\n';

test('STORAGE: Your files — upload, download and delete, kept with Hugging Face', async ({
	page
}) => {
	expect(DATABASE_URL, 'SCENARIO_DATABASE_URL is needed to read the sign-in code').toBeTruthy();
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});

	await openHome(page);
	await narrate(
		'This is Storage: the files Alpha holds for you. Jo starts at AI Potluck and signs in, since files belong to an account.'
	);
	await waitForNarration();
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await signInWithEmailOtp(page, DATABASE_URL!, EMAIL, {
		viaNavLink: true,
		skipPendingLabelCheck: true
	});

	const files = page.getByRole('link', { name: 'Files' }).first();
	await expect(files).toBeVisible({ timeout: 30_000 });
	await narrate('Files sits in the chat rail, next to the conversations.');
	await click(files);
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
	// Where the files live is a storage setting (CUR-4363); the Files page links there.
	const manage = page.getByRole('link', { name: 'Manage storage' });
	await expect(manage).toBeVisible();
	await narrate(
		'Manage storage, under the list, says where the files live: a Hugging Face bucket held by Current AI, the nonprofit that runs Alpha.'
	);
	await highlight(manage);
	await waitForNarration();

	// Upload
	await narrate('Jo chooses a file to keep here.');
	const uploaded = page.waitForResponse(
		(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
		{ timeout: 30_000 }
	);
	const chooser = page.waitForEvent('filechooser');
	await click(page.getByRole('button', { name: /^Choose a file/ }));
	await (
		await chooser
	).setFiles({ name: NAME, mimeType: 'text/plain', buffer: Buffer.from(CONTENT) });
	expect((await uploaded).ok(), 'the upload was refused').toBe(true);
	const row = page.getByRole('button', { name: `Download ${NAME}` });
	await expect(row).toBeVisible({ timeout: 30_000 });
	const meter = page.getByRole('meter', { name: '1 file' });
	await expect(meter).toBeVisible();
	await narrate('It is listed, and the meter counts it against the quota.');
	await zoom(meter, 1.5);
	await waitForNarration();

	// Download
	await narrate('Download hands back exactly the file that went in.');
	const [download] = await Promise.all([page.waitForEvent('download'), click(row)]);
	expect(readFileSync((await download.path())!, 'utf8'), 'the download is not the upload').toBe(
		CONTENT
	);
	await waitForNarration();

	// Delete
	await narrate('And deleting it asks once, then removes it from the bucket.');
	await click(page.getByRole('button', { name: `Delete ${NAME}` }));
	const dialog = page.getByRole('dialog', { name: 'Delete this file?' });
	await expect(dialog).toBeVisible();
	await waitForNarration();
	await click(dialog.getByRole('button', { name: 'Delete', exact: true }));
	await expect(page.getByRole('button', { name: `Delete ${NAME}` })).toHaveCount(0, {
		timeout: 30_000
	});
	await narrate(
		'That is Storage: your files, kept where the page says, and yours to take back or remove.'
	);
	await waitForNarration();
});
