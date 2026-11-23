// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { startChattingPastWelcome } from './helpers/welcome';

// One account could send turns all day and spend the service-wide daily cap for everyone. Each account
// now has its own day's share (chatTurnAllowance.ts). Preview-only: `daily_turn_cap_low`
// lowers the share to two turns, so the third send from the same account is refused with the limit
// message and keeps its text, while a second account on the same lowered cap still gets an answer.

const CAP = 2;

async function sendAndAwaitAnswer(page: Page, text: string, answers: number): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(text);
	await composer.press('Enter');
	const assistant = page.locator('[data-message-role="assistant"]');
	await expect(assistant, `answer ${answers} never appeared`).toHaveCount(answers, {
		timeout: 60_000
	});
	await expect(turnDone(assistant.last())).toBeVisible({ timeout: 60_000 });
}

test(
	"an account past its day's turns reads the limit message, and another account still gets answers",
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await startChattingPastWelcome(welcome);
		});
		await installFaultInjectionHeader(page, 'daily_turn_cap_low');

		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		for (let i = 1; i <= CAP; i++) {
			await sendAndAwaitAnswer(page, `What is ${i} plus ${i}?`, i);
		}

		const over = 'What is the capital of Norway?';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill(over);
		await composer.press('Enter');
		await expect(
			page.getByTestId('chat-error-toast'),
			'the turn past the daily cap was not refused with the limit message'
		).toContainText(`You've reached today's message limit of ${CAP} messages`, { timeout: 30_000 });
		await expect(composer, 'the refused text was lost').toHaveValue(over);
		await expect(
			page.locator('[data-message-role="assistant"]'),
			'the refused turn was answered anyway'
		).toHaveCount(CAP);

		// A second account, same lowered cap: its own count starts at zero, so it is answered.
		await signInAsFreshUser(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await sendAndAwaitAnswer(page, 'What is the capital of Finland?', 1);
		await expect(page.getByTestId('chat-error-toast')).toHaveCount(0);
	}
);
