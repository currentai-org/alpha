// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// Asked to summarise "this agenda" with nothing attached, Alpha would invent board items (CUR-1835). A
// turn that names a document the conversation does not contain is answered by the server
// before any model call (`missingDocument.ts`), so its reply is exact and this spec can assert it
// word for word. The second test is the other half of the contract: a real paste earlier in the
// conversation keeps the turn away from that reply.

async function openChat(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

async function send(page: Page, text: string, why: string) {
	const answers = page.locator('[data-message-role="assistant"]');
	const before = await answers.count();
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(text);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	await expect(answers, why).toHaveCount(before + 1, { timeout: 30_000 });
	const answer = answers.last();
	await expect(
		answer.getByRole('button', { name: 'Copy to clipboard', exact: true }),
		why + warmupContext()
	).toBeVisible({
		timeout: 60_000
	});
	return answer;
}

test(
	'asked to summarise an agenda nobody gave, Alpha says it cannot see one instead of inventing it',
	{ tag: '@CUR-1835' },
	async ({ page }) => {
		await openChat(page);
		const answer = await send(
			page,
			'Can you summarise this agenda in three bullet points for our board?',
			'no finished answer to a request naming a document that was never given'
		);
		await expect(answer).toContainText(
			"I can't see the agenda: nothing was attached or pasted in this conversation."
		);
		// No model ran, so the receipt must say it is a fixed notice rather than credit one.
		await expect(
			answer.locator('[data-provenance="fixed"]'),
			'the missing-document reply is not stamped as a fixed reply, so its receipt credits a model that never ran'
		).toBeVisible({ timeout: 10_000 });

		// The live stream sets the stamp client-side; a reload reads what the server persisted.
		await page.reload({ waitUntil: 'commit' });
		await expect(
			page.locator('[data-message-role="assistant"]').last().locator('[data-provenance="fixed"]'),
			'after a reload the missing-document reply lost its fixed-reply stamp, so it was never persisted'
		).toBeVisible({ timeout: 30_000 });
	}
);

test(
	'a memo pasted earlier in the conversation is worked from, not reported missing',
	{ tag: '@CUR-1835' },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		await openChat(page);

		const filler = 'This paragraph is office filler about the quarterly supply order. '.repeat(70);
		const memo = `${filler}\nThe meeting room door code is 4417.\n${filler}`;
		await page.getByLabel('Message AI Potluck').evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, memo);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the files guard'
		).toBeVisible({ timeout: 10_000 });
		await send(
			page,
			'Here is a memo from the office. Reply with just "Got it."',
			'no answer to the paste turn'
		);

		const answer = await send(
			page,
			'What is the door code in the memo I pasted?',
			'no answer to the follow-up about the pasted memo'
		);
		await expect(answer).not.toContainText("I can't see the memo");
		await expect(answer, 'the follow-up did not use the pasted memo').toContainText('4417');
		await expect(
			answer.locator('[data-provenance="fixed"]'),
			'a real model answer is stamped as a fixed notice'
		).toHaveCount(0);
	}
);
