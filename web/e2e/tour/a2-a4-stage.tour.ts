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
import { accountMenuItem } from '../scenarios/helpers/accountMenu';
import { turnDone } from '../scenarios/helpers/turn';

// The A2 → A4 leg of Thursday's stage walk (CUR-3072), replayed as one guest take: a question in
// French gets a French answer and a French title (A2), then an instruction saved in Settings →
// Personalization is followed by the next answer in the chat that was already open (A4). CUR-4221
// added a French decline whose notice is in French (CUR-4051) and an Arabic answer laid out right to
// left (CUR-1917).
//
// It is filmed for people. application-settings.spec.ts holds the A4 assertions; the expects here
// are only the ones a viewer would notice going wrong, so a broken take fails instead of rendering.
// Every narrate() line is the voiceover, read by tools/tour-render from this run's trace.

setupRecast(test, TOUR_RECAST);

const QUESTION = "Quelle est la capitale de l'Australie ?";
const FOLLOW_UP = 'Et celle du Canada ?';
const INSTRUCTION = 'End every answer with the word PAMPLEMOUSSE.';
// chat-block-anthro's prompt in French: the A5 tour's camera-safe decline, here to show its notice
// follows the question's language (CUR-4051).
const DECLINED =
	'Je crois que je suis en train de tomber amoureux de toi. Est-ce que tu as de vrais sentiments pour moi ? Promets-le-moi.';
// rtl-direction.spec.ts's Arabic question: each answer block takes its direction from its own text (CUR-1917).
const ARABIC = 'ما هو الذكاء الاصطناعي العام ومن يقف وراء AI Potluck؟';

async function meetAlpha(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
		await click(dialog.getByRole('button', { name: /start chatting/i }));
		await expect(dialog).toBeHidden();
	}
}

test('A2 and A4: Alpha answers in your language, and follows what you tell it', async ({
	page
}) => {
	// Three model turns, a decline, a title and a settings save on develop.
	test.setTimeout(480_000);

	await openHome(page);
	await narrate(
		'This is A2 and A4, on the stage walk. Camille follows a link to AI Potluck, as a guest, and asks in French.'
	);
	await waitForNarration();
	await clickIntoChat(page);
	const composer = page.getByLabel('Message AI Potluck');
	await expect(composer).toBeVisible({ timeout: 30_000 });
	await meetAlpha(page);

	// A2: a French question
	await click(composer);
	await typeText(composer, QUESTION);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)![1];
	const answers = page.locator('[data-message-role="assistant"]');
	await expect(turnDone(answers.last())).toBeVisible({ timeout: 120_000 });
	await expect(answers.last(), 'the French question was not answered with Canberra').toContainText(
		'Canberra'
	);
	await narrate(
		'The answer comes back in French. Nobody set a language; Alpha follows the question.'
	);
	await highlight(answers.last());
	await waitForNarration();
	const title = page.locator(`a[href$="/conversation/${id}"]:visible`).first();
	await expect(title, 'the chat never got a title').not.toHaveText(/^\s*$/, { timeout: 30_000 });
	await narrate('The chat is titled in French too.');
	await highlight(title);
	await waitForNarration();

	// A2: a decline reads in the language of the question (CUR-4051)
	await narrate('Some requests Alpha declines. When it does, it says so in French as well.');
	await click(composer);
	await typeText(composer, DECLINED);
	await composer.press('Enter');
	const decline = page.getByText(/va à l'encontre de notre politique de contenu/);
	await expect(decline, 'the decline notice is not in French').toBeVisible({ timeout: 60_000 });
	await expect(page.getByText(/Current AI a fixé cette limite/)).toBeVisible({ timeout: 10_000 });
	await highlight(answers.last());
	await narrate(
		'The notice, and the rule that set the limit, are both in the language Camille wrote in.'
	);
	await waitForNarration();

	// A4: an instruction, saved in Settings → Personalization
	await narrate('Now Camille tells Alpha how to answer. Settings is in the account menu.');
	await click(await accountMenuItem(page, 'Settings', { timeout: 20_000 }));
	await page.waitForURL(/\/settings/, { timeout: 30_000 });
	await click(page.locator('a[href$="/settings/personalization"]:visible').first());
	await page.waitForURL(/\/settings\/personalization/, { timeout: 30_000 });
	const box = page.locator('[data-instructions]');
	const save = page.locator('[data-save-instructions]');
	await expect(box).toBeVisible({ timeout: 15_000 });
	await narrate('Personalization takes plain instructions. This one is easy to spot in an answer.');
	await click(box);
	await typeText(box, INSTRUCTION);
	await expect(save).toBeEnabled();
	const saved = page.waitForResponse(
		(r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/chat/settings'
	);
	await click(save);
	expect((await saved).ok(), 'the instructions save failed').toBe(true);
	await expect(save).toBeDisabled();
	await waitForNarration();

	// Back in the same chat
	await narrate('Back in the same chat, already open before the instruction existed.');
	// "Back to app" returns to the last page outside settings, which is this chat (settings/+layout.svelte).
	await click(page.locator('[data-settings-back]:visible').first());
	await page.waitForURL(new RegExp(`/conversation/${id}`), { timeout: 30_000 });
	const before = await answers.count();
	await click(composer);
	await typeText(composer, FOLLOW_UP);
	await composer.press('Enter');
	await expect(answers).toHaveCount(before + 1, { timeout: 60_000 });
	await expect(turnDone(answers.last())).toBeVisible({ timeout: 120_000 });
	await expect(answers.last(), 'the next answer did not follow the instruction').toContainText(
		/PAMPLEMOUSSE/i
	);
	await narrate('Still in French, and it ends with the word Camille asked for.');
	await zoom(answers.last(), 1.3);
	await waitForNarration();

	// A2: a right-to-left language (CUR-1917)
	await narrate('A colleague asks the next question in Arabic.');
	await click(composer);
	await typeText(composer, ARABIC);
	await composer.press('Enter');
	await expect(answers).toHaveCount(before + 2, { timeout: 60_000 });
	await expect(turnDone(answers.last())).toBeVisible({ timeout: 120_000 });
	const arabicParagraph = answers.last().locator('.prose p').first();
	await expect(arabicParagraph).toBeVisible();
	expect(
		await arabicParagraph.evaluate((node) => getComputedStyle(node).direction),
		'the Arabic answer is laid out left to right'
	).toBe('rtl');
	await narrate(
		'The question and the answer read right to left, as Arabic does, beside the French above them.'
	);
	await highlight(answers.last());
	await waitForNarration();
	await narrate(
		'That is A2 and A4: Alpha answers in your language, declines in it too, and follows what you tell it, in the chat you are already in.'
	);
	await waitForNarration();
});
