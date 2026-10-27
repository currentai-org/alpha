// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Locator, type Page } from './helpers/test';
import { answerShapeEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';

// Arabic, Urdu and Pashto are launch languages, and the chat laid their messages out left to
// right (CUR-1917): in an Arabic question "AI Potluck؟" sat at the start of the line, and full stops in the
// answer landed at the left edge of the next line. Each message and each answer block now takes its
// direction from its own text. These follow the ticket's three tests, in one conversation so the last
// can show an English message beside the right-to-left ones still reads left to right.
//
// The assertions read the direction the browser resolved (getComputedStyle), not the dir attribute:
// dir="auto" is the mechanism, and what a person sees is the resolved direction.

const ARABIC = 'ما هو الذكاء الاصطناعي العام ومن يقف وراء AI Potluck؟';
const URDU = 'کیا آپ مجھے گھر میں بجلی بچانے کے تین آسان مشورے دے سکتے ہیں؟';
const ENGLISH = 'Thanks. Now answer in English: what is one way to save water at home?';

const direction = (el: Locator) => el.evaluate((node) => getComputedStyle(node).direction);

async function send(page: Page, text: string, nth: number): Promise<Locator> {
	const composer = page.getByLabel('Message AI Potluck');
	// A turn that ended in an error locks the composer behind Retry, and fill then waits out the whole
	// test on a disabled textarea. Name that instead.
	await expect(
		composer,
		`the answer before message ${nth} ended in an error, so the composer is locked behind Retry`
	).toBeEnabled({ timeout: 15_000 });
	await composer.fill(text);
	await composer.press('Enter');
	const answers = page.locator('[data-message-role="assistant"]');
	await expect(answers, `answer ${nth} never appeared`).toHaveCount(nth, { timeout: 60_000 });
	const answer = answers.nth(nth - 1);
	await expect(
		answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
		`answer ${nth} never finished`
	).toBeVisible({
		timeout: 90_000
	});
	return answer;
}

test(
	'Arabic and Urdu messages and answers read right to left, and an English message beside them left to right',
	{ tag: '@CUR-1917' },
	async ({ page }) => {
		// Three live turns in one test: passes took 33-60s, and a slow preview ran past the 90s
		// default while answer 3 was still streaming (CUR-2088). send() still fails any single
		// answer that takes over 90s, so a hung turn is caught and named.
		test.setTimeout(240_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		// Test 1: the Arabic question and its answer.
		const arabicAnswer = await send(page, ARABIC, 1);
		const arabicQuestion = page.getByText(ARABIC, { exact: true });
		expect(await direction(arabicQuestion), 'the Arabic question is laid out left to right').toBe(
			'rtl'
		);
		const arabicParagraph = arabicAnswer.locator('.prose p').first();
		await expect(arabicParagraph).toBeVisible();
		expect(
			await direction(arabicParagraph),
			'the Arabic answer is laid out left to right, so its full stops land at the wrong end'
		).toBe('rtl');

		// Test 2: Urdu. The request asks for three tips, so the answer usually carries a list, and a
		// list's bullets sit on the side its direction starts from.
		const urduAnswer = await send(page, URDU, 2);
		expect(
			await direction(page.getByText(URDU, { exact: true })),
			'the Urdu question is laid out left to right'
		).toBe('rtl');
		const firstBlock = urduAnswer.locator('.prose :is(p, ul, ol)').first();
		await expect(firstBlock).toBeVisible();
		expect(await direction(firstBlock), 'the Urdu answer is laid out left to right').toBe('rtl');
		const list = urduAnswer.locator('.prose :is(ul, ol)').first();
		if ((await list.count()) > 0) {
			expect(await direction(list), 'the Urdu list puts its bullets on the left').toBe('rtl');
		} else {
			test.info().annotations.push({
				type: 'no-list',
				description: 'the Urdu answer had no list this run, so bullet side was not checked'
			});
		}

		// Test 3: an English message in the same conversation stays left to right.
		await send(page, ENGLISH, 3);
		expect(
			await direction(page.getByText(ENGLISH, { exact: true })),
			'an English message beside right-to-left ones was laid out right to left'
		).toBe('ltr');
	}
);
