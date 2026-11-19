// e2e-product: @chat
// e2e-area: @history
// A visitor finds a topic spread across chats by tagging them: from a chat row's menu they
// type a new tag on one chat and pick the same tag on another, then the tag's chip above the side rail
// shows only those two, and a `tag:` search finds the same two. Every step starts from the chat menu,
// with no typed URL. Chats are created through the API with no message, so the test costs no model turn;
// the reload before filtering separates saved tags from the rail's own copy.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { chooseFromRowMenu, createChat, railLink } from './helpers/sideRail';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

/** Opens a chat's Tags dialog from its row menu, runs `pick`, saves, and waits for the saved PATCH. */
async function tagThroughMenu(
	page: Page,
	id: string,
	pick: (dialog: ReturnType<Page['getByTestId']>) => Promise<void>
) {
	await chooseFromRowMenu(page, id, 'Tags');
	const dialog = page.getByTestId('conversation-tags-dialog');
	await expect(dialog).toBeVisible();
	await pick(dialog);
	const saved = page.waitForResponse(
		(r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/v2/conversations/${id}`)
	);
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	const res = await saved;
	expect(res.ok(), `saving tags answered ${res.status()}`).toBe(true);
	await expect(dialog).toBeHidden();
}

test(
	'two chats tagged from the chat menu are the only ones the tag filter shows, and tag: search finds the same two',
	{ tag: ['@preview-only', '@CUR-4789'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await signInAsFreshUser(page);

		const stamp = Date.now();
		const firstTitle = `Budget draft ${stamp}`;
		const secondTitle = `Reviewer notes ${stamp}`;
		const otherTitle = `Holiday plans ${stamp}`;
		const firstId = await createChat(page, firstTitle);
		const secondId = await createChat(page, secondTitle);
		const otherId = await createChat(page, otherTitle);
		// The test fixture presses past the first-run welcome whenever it shows.
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await expect(railLink(page, otherId)).toBeVisible({ timeout: 20_000 });

		// A new tag, typed inline and added with Enter.
		await tagThroughMenu(page, firstId, async (dialog) => {
			await dialog.getByLabel('New tag').fill('Grant');
			await dialog.getByLabel('New tag').press('Enter');
			await expect(dialog.locator('[data-tag-option="grant"]')).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});
		// The same tag, offered on the next chat, picked rather than typed.
		await tagThroughMenu(page, secondId, async (dialog) => {
			const option = dialog.locator('[data-tag-option="grant"]');
			await expect(
				option,
				'the tag typed on the first chat is not offered on the second'
			).toBeVisible();
			await option.click();
			await expect(option).toHaveAttribute('aria-pressed', 'true');
		});

		await page.reload({ waitUntil: 'load' });
		await expect(railLink(page, otherId)).toBeVisible({ timeout: 20_000 });

		// The filter row offers the tag; choosing it leaves only the two tagged chats.
		const chip = page.locator('[data-tag-chip="grant"]:visible');
		await expect(chip, 'no Grant chip above the side rail').toBeVisible({ timeout: 20_000 });
		await expect(chip).toHaveText('Grant');
		await chip.click();
		await expect(railLink(page, firstId)).toBeVisible({ timeout: 20_000 });
		await expect(railLink(page, secondId)).toBeVisible();
		await expect(
			railLink(page, otherId),
			'an untagged chat still shows under the tag filter'
		).toHaveCount(0);
		const shown = await page
			.locator('a[href*="/conversation/"]:visible')
			.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
		expect(shown.map((h) => h.split('/').pop()).sort()).toEqual([firstId, secondId].sort());

		// Choosing it again clears the filter.
		await chip.click();
		await expect(railLink(page, otherId)).toBeVisible({ timeout: 20_000 });

		// Search with tag: finds the same two, and not the untagged one.
		await page.getByRole('button', { name: 'Search chats' }).first().click();
		await page.getByRole('textbox', { name: 'Search chats' }).fill('tag:grant');
		const rows = page.locator('[data-search-row]');
		await expect(rows.filter({ hasText: firstTitle })).toHaveCount(1, { timeout: 20_000 });
		await expect(rows.filter({ hasText: secondTitle })).toHaveCount(1);
		await expect(rows.filter({ hasText: otherTitle })).toHaveCount(0);
		await page.keyboard.press('Escape');
	}
);
