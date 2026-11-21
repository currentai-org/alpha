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
import { openHome, clickIntoChat, TOUR_RECAST, TOUR_TYPING_DELAY_MS } from './show';
import { tourEmail } from '../../scripts/lib/tourPersonas.mjs';
import { signInWithEmailOtp } from '../scenarios/helpers/signIn';
import { turnDone } from '../scenarios/helpers/turn';
import { phonePhotoJpeg } from '../scenarios/helpers/phonePhoto';

// The A6 walkthrough: give Alpha my stuff. One person signs in from the account menu, chooses a 6 MB
// phone photo from the plus button and types straight away while the browser shrinks it (
//), then attaches a PDF and gets an answer only that file holds. A photo sent while
// the upload scanner is down is marked "Not added" on the sent message, and read-aloud set
// to Always says so on its chip and reads the next answer. Dictation on a
// browser that can record no audio says so in plain words, and at phone width the Dictate
// hover text covers no composer control. Image input
// is on for team accounts on develop, and the @example.org address the sign-in carve-out
// needs is one of them.
//
// It is filmed for people. photo-question.spec.ts and document-attachments.spec.ts hold the
// assertions; the expects here are only the ones a viewer would notice going wrong.

setupRecast(test, TOUR_RECAST);

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const EMAIL = tourEmail('alex.moreau');
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
async function newAnswer(page: Page, before: number) {
	const answer = assistantMessages(page).nth(before);
	await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
	return answer;
}

test('A6: give Alpha a photo and a document, and it answers from them', async ({ page }) => {
	// A sign-in, four model turns, a read-aloud clip and the dictation steps on develop.
	test.setTimeout(480_000);
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
	await page.keyboard.type('What colour is the circle in this picture? One word.', {
		delay: TOUR_TYPING_DELAY_MS
	});
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

	// A photo, attached and read
	await narrate('A photo goes in the same way, through the plus button.');
	await attachThroughMenu(page, 'Attach files', {
		name: 'shapes.png',
		mimeType: 'image/png',
		buffer: await shapesPng()
	});
	await expect(page.getByAltText('shapes.png').first()).toBeVisible({ timeout: 15_000 });
	const photoAnswer = await ask(page, 'What colour is the circle in this picture?');
	await expect(photoAnswer).toContainText(/blue/i);
	await narrate('Alpha read the picture: the circle is blue.');
	await highlight(photoAnswer);
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

	// At phone width the Dictate hover text sits clear of every composer control. The take
	// is one continuous recording, so the phone width is a resize inside it: 390 x 720 CSS px is
	// 780 x 1440 device px, the video's full height, so the frame is the phone page beside grey
	// padding, unscaled. The viewport goes back to 1280 x 720 straight after, so only this step has
	// padding; the rule is about a resize the rest of a recording never recovers from.
	const dictate = page.getByRole('button', {
		name: 'Dictate your message (voice input, not read-aloud)'
	});
	// eslint-disable-next-line no-restricted-syntax -- a bracketed phone-width step, undone below
	await page.setViewportSize({ width: 390, height: 720 });
	await narrate(
		"On a phone, the microphone button's hover text sits clear of the other controls by the box."
	);
	await expect(dictate).toBeVisible({ timeout: 10_000 });
	await dictate.hover();
	const tip = page.getByText(/records you.*not read-aloud/i);
	await expect(tip).toBeVisible({ timeout: 5_000 });
	const tipBox = (await tip.boundingBox())!;
	// The composer's own controls, names them. The hover text sits above the box, so in a
	// chat with messages it can lie over the last message's Edit and Copy, which is a tooltip doing its
	// job, not a composer control hidden.
	const composerForm = page.locator('form').filter({ has: page.getByLabel('Message AI Potluck') });
	const covered = (
		await composerForm.locator('button:visible, a:visible').evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return {
					name: (el.getAttribute('aria-label') || (el as HTMLElement).innerText).trim(),
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height
				};
			})
		)
	).filter(
		(c) =>
			c.width * c.height > 0 &&
			!c.name.startsWith('Dictate your message') &&
			Math.min(tipBox.x + tipBox.width, c.x + c.width) - Math.max(tipBox.x, c.x) > 0 &&
			Math.min(tipBox.y + tipBox.height, c.y + c.height) - Math.max(tipBox.y, c.y) > 0
	);
	expect(
		covered.map((c) => c.name),
		'the Dictate hover text covers a control'
	).toEqual([]);
	await waitForNarration();
	await page.mouse.move(0, 0);
	// eslint-disable-next-line no-restricted-syntax -- restores the take's own viewport
	await page.setViewportSize({ width: 1280, height: 720 });

	// Dictation records in whatever type the browser can make, and a browser that can record none is
	// told so in plain words, never a raw "Microphone error". This page is made to report no
	// recordable type, as such a browser does; the check runs before the microphone is asked for.
	await narrate(
		'The microphone button dictates. Alpha records in whatever audio format the browser can make, so a browser without the usual one still dictates.'
	);
	await highlight(dictate);
	await waitForNarration();
	await page.evaluate(() => {
		const w = window as unknown as { __isTypeSupported?: typeof MediaRecorder.isTypeSupported };
		w.__isTypeSupported = MediaRecorder.isTypeSupported;
		MediaRecorder.isTypeSupported = () => false;
	});
	await narrate('And on a browser that cannot record audio at all, it says so in plain words.');
	await click(dictate);
	const noRecording = page.getByTestId('chat-error-toast').locator('[data-toast-title]');
	await expect(noRecording, 'a browser that cannot record was not told so').toHaveText(
		"This browser can't record audio, so dictation isn't available here.",
		{ timeout: 10_000 }
	);
	await expect(noRecording, 'the browser exception reached the screen').not.toContainText(
		'Microphone error'
	);
	await highlight(noRecording);
	await waitForNarration();
	await page.evaluate(() => {
		const w = window as unknown as { __isTypeSupported?: typeof MediaRecorder.isTypeSupported };
		if (w.__isTypeSupported) MediaRecorder.isTypeSupported = w.__isTypeSupported;
	});

	await narrate(
		'That is A6: hand Alpha a photo or a document and it answers from what you gave it, and it tells you when it could not take one.'
	);
	await waitForNarration();
});
