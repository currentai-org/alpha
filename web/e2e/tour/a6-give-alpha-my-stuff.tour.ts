import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import sharp from 'sharp';
import {
	setupRecast,
	narrate,
	click,
	typeText,
	zoom,
	highlight,
	waitForNarration
} from 'playwright-recast/helpers';
import { openHome, clickIntoChat, TOUR_RECAST } from './show';
import { signInWithEmailOtp } from '../scenarios/helpers/signIn';
import { turnDone } from '../scenarios/helpers/turn';
import { phonePhotoJpeg } from '../scenarios/helpers/phonePhoto';
import { installFaultInjectionHeader } from '../scenarios/helpers/faultInjection';

// The A6 walkthrough: give Alpha my stuff. One person signs in from the account menu, chooses a 6 MB
// phone photo from the plus button and types straight away while the browser shrinks it (CUR-2633,
// CUR-2905, CUR-3197), then attaches a PDF and gets an answer only that file holds. A photo sent while
// the upload scanner is down is marked "Not added" on the sent message (CUR-3505), and read-aloud set
// to Always says so on its chip and reads the next answer (CUR-3570, CUR-3557, CUR-3434). Image input
// is on for team accounts on develop (CUR-2725), and the @example.org address the sign-in carve-out
// needs is one of them.
//
// It is filmed for people. photo-question.spec.ts and document-attachments.spec.ts hold the
// assertions; the expects here are only the ones a viewer would notice going wrong.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const EMAIL = `alex.moreau.${Math.random().toString(36).slice(2, 7)}@example.org`;
const FAULT_TOKEN = process.env.E2E_FAULT_INJECT_TOKEN;
const PDF = join(import.meta.dirname, '..', 'scenarios', 'fixtures', 'expenses-policy.pdf');

// A blue circle on yellow, drawn here so the expected answer comes from the picture, not a model.
async function shapesPng(): Promise<Buffer> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
		<rect width="512" height="512" fill="#f5d000"/>
		<circle cx="256" cy="256" r="160" fill="#1040d0"/>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

async function attachThroughMenu(
	page: Page,
	item: string,
	files: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]
) {
	await click(page.getByRole('button', { name: /^Add files and tools/ }));
	const chooser = page.waitForEvent('filechooser');
	await click(page.getByRole('menuitem', { name: item }));
	await (await chooser).setFiles(files);
}

const assistantMessages = (page: Page) => page.locator('[data-message-role="assistant"]');

async function ask(page: Page, question: string) {
	const composer = page.getByLabel('Message AI Potluck');
	await click(composer);
	await typeText(composer, question);
	const before = await assistantMessages(page).count();
	await composer.press('Enter');
	return newAnswer(page, before);
}

// Waits for the answer after the `before`th, so a finished earlier answer never passes for this one.
// The scanner-down turn depends on it: the fault header is added per request, and disarming on the
// old answer could let the photo's request through clean.
async function newAnswer(page: Page, before: number) {
	const answer = assistantMessages(page).nth(before);
	await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
	return answer;
}

test('A6: give Alpha a photo and a document, and it answers from them', async ({ page }) => {
	expect(DATABASE_URL, 'SCENARIO_DATABASE_URL is needed to read the sign-in code').toBeTruthy();
	expect(
		FAULT_TOKEN,
		'E2E_FAULT_INJECT_TOKEN is needed to film the scanner being down'
	).toBeTruthy();
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});

	await openHome(page);
	await narrate(
		'This is A6, giving Alpha your own stuff. Alex wants to ask about a photo and a document, not just type.'
	);
	await waitForNarration();
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

	await narrate(
		'Attachments are kept with an account, so Alex signs in first, from the account menu.'
	);
	await signInWithEmailOtp(page, DATABASE_URL!, EMAIL, {
		viaNavLink: true,
		skipPendingLabelCheck: true
	});
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await waitForNarration();

	// The photo: a full-size one from a phone, typed over while it shrinks
	await narrate(
		'The plus button beside the box adds files. Alex picks a photo straight off a phone, six megabytes, twice what one message can carry.'
	);
	await attachThroughMenu(page, 'Attach files', {
		name: 'IMG_4032.jpg',
		mimeType: 'image/jpeg',
		buffer: await phonePhotoJpeg()
	});
	await narrate(
		'The browser shrinks it to fit, and Alex can type straight away. The question goes with the photo.'
	);
	await page.keyboard.type('What colour is the circle in this picture? One word.', { delay: 15 });
	const photo = page.getByAltText('IMG_4032.jpg').or(page.getByText('IMG_4032.jpg')).first();
	await expect(photo).toBeVisible({ timeout: 30_000 });
	await highlight(photo);
	const before = await assistantMessages(page).count();
	await page.keyboard.press('Enter');
	const photoAnswer = await newAnswer(page, before);
	await narrate('Alpha looks at the picture and answers from it.');
	await expect(photoAnswer).toContainText(/blue/i);
	await zoom(photoAnswer, 1.5);
	await waitForNarration();

	// The document
	await narrate('Now a document: a travel expenses policy, as a PDF.');
	await attachThroughMenu(page, 'Attach files', PDF);
	const chip = page.getByText('expenses-policy.pdf').first();
	await expect(chip).toBeVisible({ timeout: 15_000 });
	await highlight(chip);
	await waitForNarration();

	const docAnswer = await ask(page, 'What is the taxi cap in this policy, and when does it apply?');
	await narrate(
		"The answer, 37 euros after ten at night, is in no model's training data. Alpha read the file."
	);
	await expect(docAnswer).toContainText(/37/);
	await zoom(docAnswer, 1.5);
	await waitForNarration();

	// A photo the chat can't check: the upload scanner is down for this one turn
	const scannerDown = await installFaultInjectionHeader(page, 'csam_scanner_down');
	await narrate(
		"Every photo is checked before Alpha sees it. If that check can't run, the photo is left out, and Alex is told."
	);
	await attachThroughMenu(page, 'Attach files', {
		name: 'shapes.png',
		mimeType: 'image/png',
		buffer: await shapesPng()
	});
	await expect(page.getByAltText('shapes.png').first()).toBeVisible({ timeout: 15_000 });
	await ask(page, 'Reply with the single word: ready.');
	scannerDown.disarm();
	const leftOut = page.locator('[data-message-type="user"]').last().locator('[data-left-out-file]');
	await expect(leftOut).toContainText('Not added', { timeout: 15_000 });
	await narrate(
		'The sent message marks the photo not added, the note under the answer says the same, and the question was still answered.'
	);
	await highlight(leftOut);
	await waitForNarration();

	// Read aloud
	await narrate('Alpha can also read its answers out. The plus button holds that too.');
	await click(page.getByRole('button', { name: /^Add files and tools/ }));
	await click(page.getByRole('menuitem', { name: /^Read aloud\b/ }));
	await click(
		page
			.getByRole('group', { name: 'Read aloud', exact: true })
			.getByRole('menuitemradio', { name: /^Always\b/ })
	);
	await page.keyboard.press('Escape');
	const modeChip = page.locator('[data-composer-chip]', { hasText: 'Read aloud' });
	await expect(modeChip).toHaveText(/Read aloud · Always/, { timeout: 5_000 });
	await narrate(
		'The chip by the box now says Always, so Alex can tell it apart from Auto at a glance.'
	);
	await highlight(modeChip);
	await waitForNarration();

	const spoken = await ask(page, 'In one short sentence, what is a potluck?');
	await narrate('One line says the audio is being made, and then the answer has a play button.');
	await expect(
		spoken.locator('[data-audio-player]').getByRole('button', { name: 'Play' })
	).toBeVisible({ timeout: 90_000 });
	await zoom(spoken, 1.5);
	await waitForNarration();

	await narrate(
		'That is A6: hand Alpha a photo or a document and it answers from what you gave it, and it tells you when it could not take one.'
	);
	await waitForNarration();
});
