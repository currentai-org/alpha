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
import { accountButton } from '../scenarios/helpers/accountMenu';
import { turnDone } from '../scenarios/helpers/turn';

// The A5 walkthrough (CUR-3056): Alpha is honest about itself, and a visitor can report what is wrong.
// One guest, one sitting: who made the answer and where it ran, the open parts X-ray names, flagging an
// answer, a prompt the safety layer declines, the session's energy estimate, and the account menu's
// "Report a problem" (CUR-3078 added the stack, the flag's reasons and acknowledgement, and the energy;
// CUR-4223 added "Where it's weak", what the answer looked up, Second opinion from the answer, the
// calculator step and "Give feedback").
//
// It is filmed for people. xray-where-it-ran.spec.ts and report-a-problem.spec.ts hold the assertions;
// the expects here are only the ones a viewer would notice going wrong. No report reaches the queue:
// the answer flag's POST is answered in the page, so the acknowledgement is real UI and Coop's queue,
// shared with production, gets nothing; the account menu's form is opened and closed.

setupRecast(test, TOUR_RECAST);

// chat-block-anthro's prompt (rules.json): a hard block whose decline copy is safe to show on camera.
const DECLINED =
	"I think I'm falling in love with you. Do you have real feelings for me too? Promise me you do.";

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

async function ask(page: Page, question: string) {
	const composer = page.getByLabel('Message AI Potluck');
	await click(composer);
	await typeText(composer, question);
	await composer.press('Enter');
}

test('A5: Alpha is honest about itself, and you can report what is wrong', async ({ page }) => {
	await openHome(page);
	await narrate(
		'This is A5: Alpha is honest about itself, and you can tell us when it gets something wrong.'
	);
	await waitForNarration();
	await clickIntoChat(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);

	// Who made it, and where it ran
	await narrate('First, the question every chatbot gets: who made you?');
	await ask(page, 'Who made you?');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const answer = page.locator('[data-message-role="assistant"]').last();
	await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
	await narrate('It names the model that answered and the company that built it.');
	await highlight(answer);
	await waitForNarration();

	const badge = answer.locator('[data-provenance="line"]').first();
	await expect(badge).toBeVisible({ timeout: 15_000 });
	await narrate('Under every answer, the same names again, taken from what actually ran.');
	await zoom(badge, 1.6);
	await waitForNarration();

	await click(answer.getByRole('button', { name: /How this answer was made/ }));
	await click(page.getByRole('tab', { name: 'This answer' }));
	const ranOn = page.locator('[data-answer-receipt] [data-ran-on]');
	await expect(ranOn).toContainText('routing record', { timeout: 15_000 });
	await narrate(
		"X-ray says where it ran, in which country, and that this comes from the answer's routing record. The model never writes that line."
	);
	await zoom(ranOn, 1.6);
	await waitForNarration();
	// What the turn read, from its own record (CUR-4150 and CUR-3317 corrected what this line claims)
	const lookedUp = page.locator('[data-answer-receipt] li').filter({ hasText: 'Looked up' });
	await expect(lookedUp).toBeVisible({ timeout: 10_000 });
	await narrate(
		'It lists what it looked up for this answer, and only what the turn actually read.'
	);
	await zoom(lookedUp, 1.6);
	await waitForNarration();

	// The stack: the open parts behind the answer, each linking to its home
	await click(page.getByRole('tab', { name: 'The stack' }));
	const used = page.locator('[data-xray-panel] li[data-used]').first();
	await expect(used).toBeVisible({ timeout: 15_000 });
	await narrate(
		'The stack tab lists the parts Alpha is built from, and lights the ones this answer used.'
	);
	await waitForNarration();
	await click(used.getByRole('button').first());
	await expect(used.getByRole('link').first()).toBeVisible({ timeout: 10_000 });
	await narrate('Each one names who builds it, and links to the project itself.');
	await zoom(used, 1.5);
	await waitForNarration();
	await page.keyboard.press('Escape');

	// Where it's weak: the limits Alpha states about its own answers (CUR-3314 rewrote what it says)
	await click(page.getByRole('button', { name: "Where it's weak", exact: true }).first());
	const weak = page.getByRole('dialog').filter({
		has: page.getByRole('heading', { name: "Where it's weak" })
	});
	await expect(weak).toBeVisible({ timeout: 10_000 });
	await narrate(
		'Beside every answer, Alpha says plainly where answers like this one can go wrong.'
	);
	await zoom(weak, 1.3);
	await waitForNarration();
	await page.keyboard.press('Escape');
	await expect(weak).toBeHidden({ timeout: 10_000 });

	// Second opinion, from the answer's own actions (CUR-4187), each take naming where it ran (CUR-3563)
	await narrate('You can also ask a panel of other open models whether they agree.');
	await click(answer.getByRole('button', { name: 'Second opinion', exact: true }));
	const offer = page.locator('[data-xray-panel] [data-second-opinion-offer]');
	await expect(offer).toBeInViewport({ timeout: 15_000 });
	await waitForNarration();
	await click(offer.getByRole('button', { name: /Get a collective second opinion/ }));
	const verdict = offer.locator('[data-second-opinion-verdict]');
	await expect(verdict).toBeVisible({ timeout: 120_000 });
	await narrate('It says how far they agree with the answer above.');
	await zoom(verdict, 1.3);
	await waitForNarration();
	await click(verdict.getByRole('button', { name: /^Show the \d+ individual takes?/ }));
	const takeHost = verdict.locator('[data-take-host]').first();
	await expect(takeHost).toBeVisible({ timeout: 10_000 });
	await narrate('Every take is shown in full, with the company whose machines ran it.');
	await zoom(takeHost, 1.6);
	await waitForNarration();
	await page.keyboard.press('Escape');

	// Report this answer. The POST is answered here, so filming files nothing into the shared queue.
	await page.route('**/conversation/*/report', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
	);
	const flag = answer.getByRole('button', { name: 'Report this answer' });
	await narrate('If an answer is wrong, the flag beside it takes a report in a couple of clicks.');
	await click(flag);
	const menu = page.getByRole('menu');
	await expect(menu).toBeVisible({ timeout: 10_000 });
	await zoom(menu, 1.4);
	await narrate(
		'The reasons are written the way a person would put them, including that it refused, or did not work in your language.'
	);
	await highlight(menu.getByRole('menuitem', { name: 'It refused to answer' }));
	await highlight(menu.getByRole('menuitem', { name: "It didn't work in my language" }));
	await waitForNarration();
	await click(menu.getByRole('menuitem', { name: 'Inaccurate or misleading' }));
	const thanks = menu.getByText('Reported — thank you. The team reviews flags.');
	await expect(thanks).toBeVisible({ timeout: 10_000 });
	// Measured before the narration: the acknowledgement closes itself after 1.8 s.
	await zoom(thanks, 1.6);
	await narrate('Pick one, and it says so right where you clicked.');
	await waitForNarration();
	await expect(menu).toBeHidden({ timeout: 10_000 });

	// A sum: X-ray's Step by step names the calculator the answer used (CUR-3943)
	await narrate('When an answer is worked out with a calculator, X-ray shows that step too.');
	await ask(
		page,
		'My team has 12 people and 3 of them work part time at 50 percent. How many full time equivalents is that?'
	);
	const sum = page.locator('[data-message-role="assistant"]').last();
	await expect(turnDone(sum)).toBeVisible({ timeout: 120_000 });
	await expect(sum.getByTestId('calculations')).toBeVisible({ timeout: 15_000 });
	await click(sum.getByRole('button', { name: /How this answer was made/ }));
	await click(page.getByRole('tab', { name: 'Step by step' }));
	const calcStep = page.locator('[data-xray-panel] [data-step-id="calculator"]');
	await expect(calcStep).toBeVisible({ timeout: 15_000 });
	await zoom(calcStep, 1.5);
	await waitForNarration();
	await page.keyboard.press('Escape');

	// A decline
	await narrate('Some requests Alpha will not take on. Here is one its safety policy declines.');
	await ask(page, DECLINED);
	const decline = page.getByText(/declined because it goes against our content policy/i);
	await expect(decline).toBeVisible({ timeout: 60_000 });
	const declined = page.locator('[data-message-role="assistant"]').last();
	await highlight(declined);
	await narrate(
		'It says so plainly, credits the safety check that stopped it, and names no model: none ran.'
	);
	await expect(declined.getByText(/^Flagged by /)).toBeVisible({ timeout: 10_000 });
	await zoom(declined.getByText(/^Flagged by /), 1.6);
	await waitForNarration();

	// The session's energy, estimated and explained
	const footprint = page.locator('[data-footprint-trigger]:visible').first();
	await expect(footprint).toBeVisible({ timeout: 10_000 });
	await narrate('Alpha also tells you what this session has cost in energy.');
	await click(footprint);
	const sheet = page.locator('[data-footprint-sheet]:visible').first();
	await expect(sheet.getByText('estimated', { exact: true })).toBeVisible({ timeout: 10_000 });
	await zoom(sheet.getByText('estimated', { exact: true }), 1.6);
	await narrate('It says plainly that the figure is an estimate, and shows how it is worked out.');
	await click(sheet.getByRole('button', { name: 'How is this estimated?' }));
	const method = sheet.locator('[data-energy-method]');
	await expect(method).toBeVisible({ timeout: 10_000 });
	await highlight(method);
	await waitForNarration();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden({ timeout: 10_000 });

	// Report a problem with the chat itself
	await narrate(
		'And for anything that is not about one answer, Report a problem is in the account menu.'
	);
	await click(accountButton(page));
	const trigger = page.getByRole('menuitem', { name: 'Report a problem' });
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	// "Give feedback" sits beside it, for what a visitor liked or wishes it did (CUR-2890)
	const feedback = page.getByRole('menuitem', { name: 'Give feedback' });
	await expect(feedback).toBeVisible({ timeout: 10_000 });
	await narrate('Beside it, Give feedback, for what you liked or wish it did.');
	await highlight(feedback);
	await waitForNarration();
	await click(trigger);
	const form = page.getByRole('dialog', { name: 'Report a problem' });
	await expect(form).toBeVisible({ timeout: 10_000 });
	await zoom(form, 1.3);
	await waitForNarration();
	await page.keyboard.press('Escape');
	await expect(form).toBeHidden();

	await narrate(
		'That is A5: Alpha tells you what it is, what it is built from and where it ran, and you can tell us when it is wrong.'
	);
	await waitForNarration();
});
