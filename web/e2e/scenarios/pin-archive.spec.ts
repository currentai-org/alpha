// e2e-product: @chat
// e2e-area: @history
// A visitor tidies the side rail without losing a chat: a pinned chat heads the rail after a
// reload, an archived chat leaves the rail but is listed under Settings → Archived chats and still turns
// up in search, labelled archived, and Unarchive brings it back. Chats are created through the API with no
// message, so the test costs no model turn; every reload separates a saved flag from an optimistic one.
import { test, expect } from './helpers/test';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { composerHydrated } from './helpers/composer';
import { signInAsFreshUser } from './helpers/session';
import { chooseFromRowMenu, createChat, railLink } from './helpers/sideRail';

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'a pinned chat heads the side rail after a reload, and an archived one leaves it but stays in Archived chats and in search',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await signInAsFreshUser(page);

		const stamp = Date.now();
		const olderTitle = `Pin target ${stamp}`;
		const newerTitle = `Archive target ${stamp}`;
		const olderId = await createChat(page, olderTitle);
		const newerId = await createChat(page, newerTitle);
		// The test fixture presses past the first-run welcome whenever it shows.
		await page.goto(chatEntry(), { waitUntil: 'load' });

		// Pin the older chat: without a pin the newer one is first, so first place can only be the pin.
		await expect(railLink(page, newerId)).toBeVisible({ timeout: 20_000 });
		await chooseFromRowMenu(page, olderId, 'Pin');
		await expect(page.getByText('Pinned', { exact: true }).first()).toBeVisible();

		await page.reload({ waitUntil: 'load' });
		await expect(railLink(page, olderId)).toBeVisible({ timeout: 20_000 });
		const railOrder = await page
			.locator('a[href*="/conversation/"]:visible')
			.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
		expect(
			railOrder.findIndex((h) => h.endsWith(`/conversation/${olderId}`)),
			'the pinned chat is not first in the rail after a reload'
		).toBe(0);
		expect(railOrder.some((h) => h.endsWith(`/conversation/${newerId}`))).toBe(true);

		// Archive the newer chat: it leaves the rail, and stays gone after a reload.
		const archived = page.waitForResponse(
			(r) =>
				r.request().method() === 'PATCH' && r.url().endsWith(`/api/v2/conversations/${newerId}`)
		);
		await chooseFromRowMenu(page, newerId, 'Archive');
		expect((await archived).ok(), 'the archive PATCH was refused').toBe(true);
		await expect(railLink(page, newerId)).toHaveCount(0);
		await page.reload({ waitUntil: 'load' });
		await expect(railLink(page, olderId)).toBeVisible({ timeout: 20_000 });
		await expect(railLink(page, newerId)).toHaveCount(0);

		// It is listed under Archived chats, not deleted.
		await page.goto(chatPath('/settings/archived'), { waitUntil: 'load' });
		const row = page.locator(`[data-archived-chat="${newerId}"]`);
		await expect(row, 'Archived chats does not list the archived chat').toBeVisible({
			timeout: 20_000
		});
		await expect(row).toContainText(newerTitle);
		await expect(page.locator(`[data-archived-chat="${olderId}"]`)).toHaveCount(0);

		// Search still finds it, labelled archived. The rail's search is on the chat page, not in settings.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		// A click on the server-rendered button before the app hydrates opens nothing, so wait for it.
		await composerHydrated(page);
		await page.getByRole('button', { name: 'Search chats' }).first().click();
		await page.getByRole('textbox', { name: 'Search chats' }).fill(newerTitle);
		const hit = page.locator('[data-search-row]', { hasText: newerTitle });
		await expect(hit.locator('[data-search-archived]')).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('Escape');

		// Unarchive brings it back to the rail.
		await page.goto(chatPath('/settings/archived'), { waitUntil: 'load' });
		await expect(row).toBeVisible({ timeout: 20_000 });
		await row.getByRole('button', { name: 'Unarchive' }).click();
		await expect(row).toHaveCount(0);
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await expect(railLink(page, newerId)).toBeVisible({ timeout: 20_000 });
	}
);
