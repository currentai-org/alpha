// e2e-product: @chat
// e2e-area: @turn
// Creating a conversation had no rate limit, so one client could insert conversations as
// fast as it could POST. Creates now have their own per-session count. Preview-only:
// `session_rate_limit_low` lowers it to one create per 30 s (faultInjection.ts), so the second new
// chat inside that window is refused. The guest sees the refusal and keeps what they typed.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import {
	CONVERSATION_CREATE_PATH,
	installFaultInjectionHeader,
	installCannedReplies
} from './helpers/faultInjection';
import { turnDone } from './helpers/turn';

test(
	'a second new chat inside the create window is refused, and the guest keeps the text',
	{ tag: ['@CUR-3529', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'session_rate_limit_low', CONVERSATION_CREATE_PATH);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		const isCreate = (r: { url(): string; request(): { method(): string } }) =>
			CONVERSATION_CREATE_PATH.test(new URL(r.url()).pathname) && r.request().method() === 'POST';

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is the capital of Norway?');
		const firstCreate = page.waitForResponse(isCreate);
		await composer.press('Enter');
		expect((await firstCreate).status(), 'the first create of the window was refused').toBe(200);
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 60_000
		});

		await page
			.getByRole('link', { name: /new chat/i })
			.first()
			.click();
		await page.waitForURL(/\/chat\/?(\?.*)?$/, { timeout: 15_000 });
		const second = 'What is the capital of Finland?';
		await composer.click({ timeout: 30_000 });
		await composer.fill(second);
		const secondCreate = page.waitForResponse(isCreate);
		await composer.press('Enter');
		expect(
			(await secondCreate).status(),
			'a second create inside the window went through: creates are not rate limited'
		).toBe(429);

		await expect(
			page.getByTestId('chat-error-toast'),
			'the refusal never reached the screen'
		).toContainText(/too many messages/i, { timeout: 5_000 });
		await expect(composer, 'the typed text was lost').toHaveValue(second);
		expect(page.url()).not.toMatch(/\/conversation\/[a-f0-9]+/);
	}
);
