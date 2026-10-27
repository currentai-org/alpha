// e2e-product: @chat
// e2e-area: @history
// A conversation can be renamed from the side rail's Conversation actions menu, and the new
// title is the one the server keeps. The conversation is created through the API with no message, so
// the test costs no model turn; the reload is what separates a saved title from an optimistic one.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'a conversation renamed from the side rail keeps its new title after a reload',
	{ tag: ['@preview-only', '@C1', '@CUR-2629'] },
	async ({ page }) => {
		await signInAsFreshUser(page);

		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId } = (await created.json()) as { conversationId: string };

		await page.goto(chatEntry(), { waitUntil: 'load' });
		await page
			.getByRole('dialog', { name: 'Welcome to Alpha' })
			.getByRole('button', { name: /start chatting/i })
			.click({ timeout: 8_000 })
			.catch(() => {});

		// The nav renders twice (desktop rail and mobile drawer); `:visible` picks this viewport's.
		await journeyStep(page, 'C1', 3, async () => {
			const link = page.locator(`a[href$="/conversation/${conversationId}"]:visible`);
			await expect(link).toBeVisible({ timeout: 20_000 });
			await link.hover();
			await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
			await page.getByRole('menuitem', { name: 'Rename' }).click();

			const dialog = page.getByRole('dialog', { name: 'Rename conversation' });
			const field = dialog.getByRole('textbox', { name: 'Title' });
			await expect(field).toHaveValue(/\S/);
			const newTitle = `Renamed ${Date.now()}`;
			await field.fill(newTitle);

			const saved = page.waitForResponse(
				(r) =>
					r.request().method() === 'PATCH' &&
					r.url().endsWith(`/api/v2/conversations/${conversationId}`)
			);
			await dialog.getByRole('button', { name: 'Save' }).click();
			expect((await saved).ok(), 'the rename PATCH was refused').toBe(true);
			await expect(dialog).toBeHidden();
			await expect(link).toHaveText(newTitle);

			await page.reload({ waitUntil: 'load' });
			await expect(page.locator(`a[href$="/conversation/${conversationId}"]:visible`)).toHaveText(
				newTitle,
				{ timeout: 20_000 }
			);
		});
	}
);
