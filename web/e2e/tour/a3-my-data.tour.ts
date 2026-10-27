import { test, expect, chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { setupRecast, narrate, click, typeText, zoom } from 'playwright-recast/helpers';
import {
	highlight,
	waitForNarration,
	openHome,
	clickIntoChat,
	TOUR_RECAST,
	TOUR_TYPING_DELAY_MS
} from './show';
import { installOtpBypassHeader, signInWithEmailOtp } from '../scenarios/helpers/signIn';
import { accountButton, accountMenuItem } from '../scenarios/helpers/accountMenu';
import { setFlagOverrides } from '../scenarios/helpers/flagOverride';
import { turnDone } from '../scenarios/helpers/turn';

// The A3 walkthrough: docs/journeys/a3-my-data.md walked as one signed-in person, rows 29, 6, 7, 21,
// 14, 3–4, 9 and 12, so the story ends on the account being deleted. Sign-in is A1's tour, so it
// happens off camera in a browser of its own and the take starts signed in, on the home page. Alex
// attaches a photo so My files has a row to open and the receipt has a file to count.
//
// It is filmed for people. data-portability.spec.ts holds the assertions; the expects here are only
// the ones a viewer would notice going wrong, so a broken take fails instead of rendering.
// Every narrate() line is the voiceover, read by tools/tour-render from this run's trace.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const QUESTION = 'This is my fern. Give me three tips for keeping it alive in winter.';
const PHOTO = 'fern.png';
const EMAIL = `alex.moreau.${Math.random().toString(36).slice(2, 7)}@example.org`;

// A green leaf shape on a pot, drawn here so the tour carries no binary fixture.
async function plantPng(): Promise<Buffer> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
		<rect width="512" height="512" fill="#f4efe6"/>
		<rect x="186" y="340" width="140" height="120" fill="#b5653a"/>
		<ellipse cx="256" cy="230" rx="90" ry="140" fill="#2f8f3a"/>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

// A settings section's link, by where it goes: on a desktop the sections sit in the sidebar, and
// Storage's accessible name there is a sentence (settingsSections.ts), not its label.
function section(page: Page, path: string) {
	return page.locator(`a[href$="/settings/${path}"]:visible`).first();
}

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

test('A3: your data is yours to take, see, and delete', async ({ page, context, baseURL }) => {
	expect(DATABASE_URL, 'SCENARIO_DATABASE_URL is needed to read the sign-in code').toBeTruthy();
	await setFlagOverrides(context, baseURL!, {
		'data-export': true,
		'custodial-storage-view': true,
		'storage-locations': true,
		// The router would send a how-to question to the agent; this tour is about the person's data.
		'agent-mode': false
	});

	// Off camera: sign in by email code in a browser of its own, then hand its cookies to the take.
	const signInBrowser = await chromium.launch();
	try {
		const signInContext = await signInBrowser.newContext({ baseURL });
		const signInPage = await signInContext.newPage();
		await signInWithEmailOtp(signInPage, DATABASE_URL!, EMAIL, { skipPendingLabelCheck: true });
		await context.addCookies(await signInContext.cookies());
	} finally {
		await signInBrowser.close();
	}
	await installOtpBypassHeader(page);

	await openHome(page);
	await narrate(
		'This is A3, my data. Alex is signed in to AI Potluck. Whatever they put in, they can take out, look at, and delete, and this tour shows where.'
	);
	await waitForNarration(page);
	await clickIntoChat(page);
	const composer = page.getByLabel('Message AI Potluck');
	await expect(composer).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);
	await expect(accountButton(page)).toHaveAccessibleName(/signed in as /i, { timeout: 15_000 });

	await narrate('First, something worth keeping: a photo of a plant, a question, and an answer.');
	await click(page.getByRole('button', { name: /^Add files and tools/ }));
	const chooser = page.waitForEvent('filechooser');
	await click(page.getByRole('menuitem', { name: 'Attach files' }));
	await (await chooser).setFiles({ name: PHOTO, mimeType: 'image/png', buffer: await plantPng() });
	await expect(page.getByAltText(PHOTO).first()).toBeVisible({ timeout: 15_000 });
	await click(composer);
	await typeText(composer, QUESTION);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversation = new URL(page.url()).pathname;
	await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
		timeout: 120_000
	});
	await waitForNarration(page);

	// Row 29 (CUR-3289)
	await narrate('The photo is now one of Alex’s files. Files in the sidebar lists it.');
	const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
	if (await openSidebar.isVisible()) await click(openSidebar);
	await click(page.getByRole('link', { name: 'Files', exact: true }));
	await page.waitForURL(/\/chat\/storage$/, { timeout: 30_000 });
	const row = page.locator('[data-file-row]').filter({ hasText: PHOTO });
	const added = row.getByText(/^Added .*\d{4}/);
	await expect(added).toBeVisible({ timeout: 30_000 });
	await highlight(added);
	await narrate('Its row says when it was added and which chat it came from.');
	await waitForNarration(page);
	await click(row.getByRole('button', { name: `Open ${PHOTO}` }));
	const preview = page.getByTestId('file-preview');
	await expect(preview).toBeVisible({ timeout: 20_000 });
	await narrate('Opening it shows the photo right here, without downloading anything.');
	await waitForNarration(page);
	await page.keyboard.press('Escape');
	await expect(preview).toBeHidden();
	await narrate('And its link goes back to the chat it was sent in.');
	await click(row.getByRole('link', { name: `Open the chat ${PHOTO} came from` }));
	await page.waitForURL((url) => url.pathname === conversation, { timeout: 30_000 });
	await waitForNarration(page);

	// Row 6
	await narrate('The account page is one click from the account menu.');
	await click(await accountMenuItem(page, 'Account', { timeout: 20_000 }));
	await page.waitForURL(/\/settings\/account/, { timeout: 30_000 });
	const exportRow = page.getByRole('link', {
		name: 'Download a ZIP of your conversations, files, and where each answer came from'
	});
	await expect(exportRow).toBeVisible({ timeout: 30_000 });
	await exportRow.scrollIntoViewIfNeeded();
	const summary = page.getByTestId('export-summary');
	await expect(summary).toContainText('1 conversation', { timeout: 15_000 });
	await narrate(
		'Download your data says what the zip file will hold before Alex asks for it: their conversations, their files, and where each answer came from.'
	);
	await zoom(exportRow, 1.4);
	await waitForNarration(page);
	const [download] = await Promise.all([page.waitForEvent('download'), click(exportRow)]);
	expect(await download.path(), 'the export click produced no file').toBeTruthy();
	await narrate(
		'One click, and the zip file downloads. It opens anywhere, with a plain README inside.'
	);
	await waitForNarration(page);

	// Rows 7 and 21. CUR-4363: Settings → Storage holds the storage settings; the files are a link away.
	await narrate('Settings, Storage says how much is stored, and where.');
	await click(section(page, 'storage'));
	await page.waitForURL(/\/settings\/storage/, { timeout: 30_000 });
	const usage = page.getByTestId('storage-usage');
	await expect(usage.getByRole('meter')).toBeVisible({ timeout: 30_000 });
	await zoom(usage, 1.4);
	await waitForNarration(page);
	await highlight(page.getByText('Everything stored is listed here', { exact: false }));
	await narrate(
		'It says who stores the files and promises that the list is complete, and deleting a file removes it from storage.'
	);
	await waitForNarration(page);
	const linkSection = page.getByTestId('storage-link-section');
	if (await linkSection.isVisible().catch(() => false)) {
		await narrate(
			'Someone who wants their files in a Hugging Face bucket of their own can link one here.'
		);
		await highlight(linkSection);
		await waitForNarration(page);
	}
	await narrate('Open your files lists the same files, with a download and a delete on each.');
	await click(page.getByRole('link', { name: 'Open your files' }));
	await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
		timeout: 30_000
	});
	await expect(page.getByRole('button', { name: `Delete ${PHOTO}` })).toBeVisible({
		timeout: 30_000
	});
	await waitForNarration(page);
	await click(page.getByRole('link', { name: 'Manage storage' }));
	await page.waitForURL(/\/settings\/storage/, { timeout: 30_000 });

	// Row 14 (CUR-2960)
	await narrate(
		'Personalization is where memory will live. Alpha does not remember Alex across chats yet, and says so.'
	);
	await click(section(page, 'personalization'));
	await page.waitForURL(/\/settings\/personalization/, { timeout: 30_000 });
	const memory = page.getByRole('heading', { name: /Alpha memory/ });
	await expect(memory).toContainText('Coming soon', { timeout: 15_000 });
	await highlight(memory);
	await waitForNarration(page);

	// Rows 3 and 4, told without confirming, since the tour ends on the stronger delete
	await narrate(
		'Data and privacy holds Forget everything, which clears every conversation and file but keeps the account.'
	);
	await click(section(page, 'data'));
	await page.waitForURL(/\/settings\/data/, { timeout: 30_000 });
	const forget = page.getByRole('button', { name: /^Forget everything/ });
	await expect(forget).toBeVisible({ timeout: 15_000 });
	await highlight(forget);
	await waitForNarration(page);

	// Row 9
	await narrate('Alex wants the account gone too. That lives on the account page.');
	await click(section(page, 'account'));
	await page.waitForURL(/\/settings\/account/, { timeout: 30_000 });
	const deleteRow = page.getByRole('button', {
		name: 'Delete your account, conversations, and sign-in methods'
	});
	await deleteRow.scrollIntoViewIfNeeded();
	await click(deleteRow);
	await expect(page.getByRole('heading', { name: 'Delete your account?' })).toBeVisible({
		timeout: 15_000
	});
	const deleteButton = page.getByRole('button', { name: 'Delete account', exact: true });
	await expect(deleteButton).toBeDisabled();
	await narrate(
		"It says what goes, that it can't be undone, and the button stays off until Alex types DELETE."
	);
	// A take once typed "ELETED": recast's typeText refocuses the field before every
	// character, which moved the caret. The dialog does not focus the field itself, so Alex clicks it once and types in one call.
	const confirmField = page.getByLabel('Type DELETE to confirm');
	await click(confirmField);
	await expect(confirmField).toBeFocused();
	await confirmField.pressSequentially('DELETE', { delay: TOUR_TYPING_DELAY_MS });
	await expect(confirmField).toHaveValue('DELETE');
	await expect(deleteButton).toBeEnabled();
	await waitForNarration(page);
	await click(deleteButton);
	const receipt = page.getByRole('heading', { name: 'Your data has been cleared' });
	await expect(receipt).toBeVisible({ timeout: 60_000 });
	// Row 12: the receipt counts the photo among what it removed
	await expect(page.getByText('1 uploaded file')).toBeVisible({ timeout: 15_000 });
	await narrate(
		'A receipt lists exactly what was removed: the account, its sign-in methods, and the photo.'
	);
	await zoom(receipt, 1.3);
	await waitForNarration(page);
	await narrate('That is A3: see what is kept, take a copy, and delete it when you are done.');
	await waitForNarration(page);
});
