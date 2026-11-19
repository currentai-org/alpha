// The side rail's chat rows, for specs that set up chats without a model turn.
import { expect } from './test';
import type { Page } from '@playwright/test';

/** Creates a chat through the API with no message, so no model turn is spent, and names it. */
export async function createChat(page: Page, title: string): Promise<string> {
	const models = (await (await page.request.get('/chat/api/models')).json()) as {
		id?: string;
		name?: string;
	}[];
	const created = await page.request.post('/chat/conversation', {
		data: { model: models[0]?.id ?? models[0]?.name }
	});
	expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
	const { conversationId } = (await created.json()) as { conversationId: string };
	const named = await page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
		data: { title }
	});
	expect(named.ok(), `naming the chat answered ${named.status()}`).toBe(true);
	return conversationId;
}

// The nav renders twice (desktop rail and mobile drawer); `:visible` picks this viewport's.
export const railLink = (page: Page, id: string) =>
	page.locator(`a[href$="/conversation/${id}"]:visible`);

/** Opens a rail row's Conversation actions menu and picks `item`. */
export async function chooseFromRowMenu(page: Page, id: string, item: string) {
	const link = railLink(page, id);
	await expect(link).toBeVisible({ timeout: 20_000 });
	await link.hover();
	await link.locator('xpath=..').getByRole('button', { name: 'Conversation actions' }).click();
	await page.getByRole('menuitem', { name: item, exact: true }).click();
}
