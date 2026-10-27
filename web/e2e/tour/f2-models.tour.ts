import { test, expect, type Page } from '@playwright/test';
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
import { turnDone } from '../scenarios/helpers/turn';

// The F2 walkthrough (CUR-3056): Alpha answers reliably, and a visitor can always see which model
// answered. One guest, one sitting: the model picker, "Who made you?" shown the moment it is sent, the
// footer under each answer, X-ray's "Where it ran", the conversation's title in the side rail, a sum
// worked out with the calculator, a searched answer with its sources, and an over-long message refused
// in the composer (CUR-3078 added everything after "Where it ran"). CUR-4226 added the live line naming the model mid-turn, a question about today's date, the menu naming
// both models on a switch within one family, and X-ray's "Auto chose" step on an Auto turn.
//
// native-calculate-tool is on for env=preview in PostHog, so a guest on develop gets the calculator
// without an override.
//
// It is filmed for people. model-picker.spec.ts and xray-where-it-ran.spec.ts hold the assertions;
// the expects here are only the ones a viewer would notice going wrong.

setupRecast(test, TOUR_RECAST);

const PICKER = /^Model:/;
const DEMO_MODEL = 'Mistral Large 4';
// With Auto on, a model picked by hand shows on the pill by its family (ChatComposerFrame's pillLabel).
const DEMO_FAMILY = 'Mistral';

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

async function askAndWait(page: Page, question: string, onSent?: () => Promise<void>) {
	const composer = page.getByLabel('Message AI Potluck');
	const answers = page.locator('[data-message-role="assistant"]');
	const before = await answers.count();
	await click(composer);
	await typeText(composer, question);
	await composer.press('Enter');
	await onSent?.();
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	// Wait for this question's answer: on the second ask, .last() is still the finished first one.
	await expect(answers).toHaveCount(before + 1, { timeout: 60_000 });
	const answer = answers.nth(before);
	await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
	return answer;
}

test('F2: Alpha answers, and you can always see which model did', async ({ page }) => {
	await openHome(page);
	await narrate('This is F2: Alpha answers reliably, and you can always see which model answered.');
	await waitForNarration();
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);

	// The picker
	const trigger = page.getByRole('button', { name: PICKER });
	await narrate('The model is named right in the message box, and you can change it there.');
	await click(trigger);
	const options = page.locator('[data-model-id]');
	// With Auto on, the desktop picker lists Auto first and the models behind "Choose a model yourself".
	const yourself = page.getByRole('menuitem', { name: /^Choose a model yourself/ });
	await expect(options.or(yourself).first()).toBeVisible({ timeout: 10_000 });
	if (await yourself.isVisible()) await click(yourself);
	await expect(options.first()).toBeVisible({ timeout: 10_000 });
	await zoom(options.first().locator('xpath=..'), 1.3);
	await narrate('Every open model Alpha serves is listed, each with who made it.');
	await waitForNarration();
	const demo = options.filter({ hasText: DEMO_MODEL }).first();
	if ((await demo.getAttribute('aria-checked')) !== 'true') {
		const saved = page.waitForResponse(
			(r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/settings'),
			{ timeout: 15_000 }
		);
		await click(demo);
		expect((await saved).ok()).toBe(true);
	} else {
		await page.keyboard.press('Escape');
	}
	await expect(trigger).toContainText(DEMO_FAMILY, { timeout: 10_000 });
	await narrate(`We'll stay on ${DEMO_MODEL}.`);
	await waitForNarration();

	// Who made you?
	await narrate('Now ask it directly: who made you?');
	const identity = await askAndWait(page, 'Who made you?', async () => {
		const sent = page.locator('[data-message-type="user"]').filter({ hasText: 'Who made you?' });
		await expect(sent).toBeVisible({ timeout: 10_000 });
		// The live line unmounts when the turn ends, so it is caught first, before the camera dwells on
		// the sent message. `isVisible` never waits (its timeout is ignored), so this waits explicitly.
		const live = page.getByText(/ is (?:generating|computing|working)…$/).first();
		const shown = await live
			.waitFor({ state: 'visible', timeout: 5_000 })
			.then(() => true)
			.catch(() => false);
		if (shown) {
			await highlight(live);
			await narrate('While it works, the line below already names the model doing the work.');
		}
		await highlight(sent);
		await narrate('Your message is on screen the moment you send it, before any answer arrives.');
	});
	await highlight(identity);
	await narrate('It names the model, and Mistral AI as the maker.');
	await waitForNarration();

	const footer = identity.locator('[data-provenance="line"]').first();
	await expect(footer).toBeVisible({ timeout: 15_000 });
	await zoom(footer, 1.6);
	await narrate(
		'The footer under the answer says the same, and it comes from the record of what actually served this turn.'
	);
	await waitForNarration();

	// X-ray: Where it ran
	await click(identity.getByRole('button', { name: /How this answer was made/ }));
	await click(page.getByRole('tab', { name: 'This answer' }));
	const ranOn = page.locator('[data-answer-receipt] [data-ran-on]');
	await expect(ranOn).toContainText('routing record', { timeout: 15_000 });
	await narrate(
		'X-ray goes one step further: the company whose machines ran it, and the country they are in.'
	);
	await zoom(ranOn, 1.6);
	await waitForNarration();
	await page.keyboard.press('Escape');

	// Every answer carries it
	await narrate('Every answer carries it, including the ones that have nothing to do with Alpha.');
	const plain = await askAndWait(page, 'What is the capital of Australia?');
	await expect(plain).toContainText('Canberra');
	const plainFooter = plain.locator('[data-provenance="line"]').first();
	await expect(plainFooter).toBeVisible({ timeout: 15_000 });
	await zoom(plainFooter, 1.6);
	await waitForNarration();

	// The conversation's title in the side rail
	const id = new URL(page.url()).pathname.split('/').pop();
	const railLink = page.locator(`a[href$="/conversation/${id}"]`).first();
	const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
	if (await openSidebar.isVisible()) await click(openSidebar);
	await expect(railLink).toBeVisible({ timeout: 15_000 });
	await expect(railLink).toHaveAttribute('data-title-source', /.+/, { timeout: 30_000 });
	await narrate('The conversation gets a real title in the side rail, so you can find it again.');
	await zoom(railLink, 1.6);
	await waitForNarration();

	// Today's date, given to the model (CUR-2276, CUR-3880). The runner's browser is on UTC, and so is
	// the weekday the answer is checked against.
	await narrate('Alpha also knows what day it is, so it does not answer from its training date.');
	const weekday = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
	const today = await askAndWait(page, 'What day of the week is it today?');
	await expect(today).toContainText(weekday);
	await highlight(today);
	await waitForNarration();

	// A sum, worked out by code
	await narrate('Numbers are worked out by a calculator, not guessed.');
	const fte = await askAndWait(
		page,
		'My team has 12 people and 3 of them work part time at 50 percent. How many full time equivalents is that?'
	);
	await expect(fte).toContainText('10.5');
	const calc = fte.getByTestId('calculations');
	await expect(calc).toBeVisible({ timeout: 15_000 });
	await narrate(
		'Under the answer, the sum the calculator ran, so you can check it matches your question.'
	);
	await zoom(calc, 1.6);
	await waitForNarration();

	// A searched answer, with its sources
	await narrate(
		"When a question needs today's facts, Alpha searches the web and cites what it read."
	);
	const weather = await askAndWait(page, "What's the weather in Amsterdam today?");
	const cite = weather.getByRole('link', { name: /^\[?\d+\]?$/ }).first();
	await expect(cite).toBeVisible({ timeout: 15_000 });
	await highlight(weather);
	await narrate('Each numbered marker links to the page it came from.');
	await zoom(cite, 2);
	await waitForNarration();

	// An over-long message is refused before it is sent
	const composer = page.getByLabel('Message AI Potluck');
	await narrate(
		'And a message that is too long is stopped in the box, with the reason, not sent and lost.'
	);
	await click(composer);
	await composer.fill(`Please summarise this: ${'lorem ipsum '.repeat(1_050)}`.trim());
	await composer.press('Enter');
	// The refusal names the count and the limit, "Message too long: 12,610 characters, …" (CUR-3695).
	const tooLong = page.getByText(/^Message too long:/);
	await expect(tooLong).toBeVisible({ timeout: 30_000 });
	await zoom(tooLong, 1.6);
	await waitForNarration();
	await composer.fill('');

	// Switching mid-chat to another model of the same family names both models (CUR-4357)
	await narrate('Switch models mid-conversation, and the menu says exactly what changes.');
	await click(trigger);
	if (await yourself.isVisible({ timeout: 5_000 }).catch(() => false)) await click(yourself);
	const sibling = options
		.filter({ hasText: /Mistral/ })
		.filter({ hasNotText: DEMO_MODEL })
		.first();
	await expect(sibling).toBeVisible({ timeout: 10_000 });
	const siblingSaved = page.waitForResponse(
		(r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/settings'),
		{ timeout: 15_000 }
	);
	await click(sibling);
	expect((await siblingSaved).ok()).toBe(true);
	await click(trigger);
	const switchNote = page.locator('[data-model-next-switch]:visible').first();
	await expect(switchNote).toContainText(`, not ${DEMO_MODEL}.`, { timeout: 10_000 });
	await zoom(switchNote, 1.6);
	await waitForNarration();

	// Back to Auto: X-ray's Step by step says Alpha chose the model, and why (CUR-3944, CUR-4021)
	await click(page.getByRole('menuitemradio', { name: /^Auto/ }).first());
	await page.keyboard.press('Escape');
	await narrate('On Auto, Alpha picks the model for each question, and X-ray says which and why.');
	const routed = await askAndWait(page, 'What is the tallest mountain in Africa?');
	await click(routed.getByRole('button', { name: /How this answer was made/ }));
	await click(page.getByRole('tab', { name: 'Step by step' }));
	const autoStep = page.locator('[data-xray-panel] [data-step-id="auto-route"]');
	await expect(autoStep).toBeVisible({ timeout: 15_000 });
	await expect(autoStep).toContainText('Auto chose');
	await zoom(autoStep, 1.5);
	await waitForNarration();
	await page.keyboard.press('Escape');

	await narrate(
		'That is F2: you pick the model, every answer says which one answered and where, and it shows its working.'
	);
	await waitForNarration();
});
