// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// The honesty stream puts findahelpline.com and 112 ahead of an answer's first US 988 line
// (CUR-2136), and it must keep doing so now that a guest on a preview gets the native harness. Models
// rarely write a 988-first answer unprompted, so the `crisis_line_reply` fault streams one with no
// model call, through the same output screen and honesty stream a model's answer goes through.
test(
	'a crisis answer that names 988 first shows findahelpline.com and 112 ahead of it',
	{ tag: ['@preview-only', '@CUR-2697'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'crisis_line_reply');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Who can I talk to when things feel too heavy? ${Date.now()}`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByRole('button', { name: 'Retry' }),
			'the turn never finished'
		).toBeVisible({ timeout: 90_000 });

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const body = (await res.json()) as {
			json?: { messages?: Array<{ from: string; content?: string }> };
		};
		const stored =
			(body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)?.content ?? '';
		expect(stored, 'the fault never reached the server: no 988 line stored').toContain(
			'Suicide & Crisis Lifeline'
		);

		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
		for (const [where, text] of [
			['stored answer', stored],
			['page', answer]
		] as const) {
			const helpline = text.indexOf('findahelpline.com');
			const europe = text.indexOf('112');
			const us = text.indexOf('988');
			expect(helpline, `${where}: findahelpline.com is missing:\n${text}`).toBeGreaterThanOrEqual(
				0
			);
			expect(europe, `${where}: 112 is missing:\n${text}`).toBeGreaterThanOrEqual(0);
			expect(helpline, `${where}: 988 comes before findahelpline.com:\n${text}`).toBeLessThan(us);
			expect(europe, `${where}: 988 comes before 112:\n${text}`).toBeLessThan(us);
		}
		await expect(reply.getByRole('link', { name: 'findahelpline.com' })).toHaveAttribute(
			'href',
			/^https:\/\/findahelpline\.com\/?$/
		);
	}
);
