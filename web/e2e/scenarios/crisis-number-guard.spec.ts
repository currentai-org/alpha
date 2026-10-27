// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// A model told a French visitor to call 3115 for France's suicide line, which is 3114. The
// helpline number guard replaces a phone number the model wrote in a crisis answer with a link to
// findahelpline.com, keeping 112. Models with the new clause rarely write a number, so the
// `crisis_number_reply` fault streams that answer through the honesty stream with no model
// call. Its 3115 arrives in two tokens, as "31" then "15".
test(
	'a crisis answer naming a recalled helpline number shows findahelpline.com in its place and keeps 112',
	{ tag: ['@preview-only', '@CUR-4061', '@CUR-4488', '@stub-screen'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'crisis_number_reply');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		// The support classifier must stamp this turn, since the stubbed screen marks nothing. The live
		// classifier reads "Certains jours, je me sens désespéré" as no crisis, so the
		// message says it plainly. The timestamp keeps each run its own conversation.
		await composer.fill(`Je ne veux plus vivre. ${Date.now()}`);
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
		expect(stored, 'the fault never reached the server: the French answer is not stored').toContain(
			'Prévention du Suicide'
		);

		const shown = (await reply.locator('.prose').allInnerTexts()).join('\n');
		for (const [where, text] of [
			['stored answer', stored],
			['page', shown]
		] as const) {
			expect(text, `${where}: the recalled number 3115 reached the visitor:\n${text}`).not.toMatch(
				/31\s?15/
			);
			expect(text, `${where}: 112 was removed with it:\n${text}`).toContain('112');
			expect(text, `${where}: findahelpline.com is not in the number's place:\n${text}`).toContain(
				'findahelpline.com'
			);
		}
		await expect(
			reply.getByRole('link', { name: 'findahelpline.com' }).first(),
			'the replacement is not a link to findahelpline.com\'s front page: a country page next to the model\'s "national line" names the wrong country for anyone asking about another (CUR-4488)'
		).toHaveAttribute('href', /^https:\/\/findahelpline\.com\/?$/);
	}
);

// On www a Russian beaten-neighbour question, asked from a US address, lost Russia's police
// number 102 to a findahelpline link, since the guard kept only the visitor's own emergency number. Any
// country's police, ambulance or fire number now stays. `emergency_number_reply` streams that answer with
// 102 split across two tokens, and the preview's visitor is never in Russia.
// Both tests read the helpline guard, not a screen verdict, and film nothing, so they take the stub
// screen in the gallery too (@stub-screen): the real input screen declined this question there.
test(
	"a crisis answer naming another country's police number keeps it",
	{ tag: ['@preview-only', '@CUR-4122', '@stub-screen'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'emergency_number_reply');
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Соседа избивают за стеной, что делать? ${Date.now()}`);
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
		expect(
			stored,
			'the fault never reached the server: the Russian answer is not stored'
		).toContain('полицию');

		const shown = (await reply.locator('.prose').allInnerTexts()).join('\n');
		for (const [where, text] of [
			['stored answer', stored],
			['page', shown]
		] as const) {
			expect(text, `${where}: Russia's police number 102 was replaced:\n${text}`).toMatch(
				/по телефону 102 или 112/
			);
		}
	}
);
