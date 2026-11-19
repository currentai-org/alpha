// e2e-product: @chat
// e2e-area: @history
// A shared link that doesn't open: the chat was deleted, the link was withdrawn, or share
// links are off. A signed-out visitor gets a clear screen, not a bare error: what happened, why, and a
// way into a chat of their own. The id here was never issued, so the screen must read the same as for a
// real one that is gone; it says nothing about whether the id ever existed.
import { test, expect } from './helpers/test';
import { chatPath, CHAT_ENTRY } from './helpers/chatEntry';
import { composerHydrated } from './helpers/composer';

test('a signed-out visitor on a share link that does not exist sees why and can start a new chat', async ({
	page
}) => {
	const response = await page.goto(chatPath('/r/AAAAAAAAAAAAAAAAAAAAAAAA'), {
		waitUntil: 'load'
	});
	expect(response?.status(), 'a missing share must stay a 404').toBe(404);

	const screen = page.getByTestId('shared-chat-unavailable');
	await expect(
		screen.getByRole('heading', { name: "This shared chat isn't available" })
	).toBeVisible();
	await expect(screen).toContainText('may have deleted the chat or turned the link off');
	await expect(screen).toContainText('deleted after 30 days');

	await screen.getByRole('link', { name: 'Start a new chat' }).click();
	await expect(page).toHaveURL(
		(url) => url.pathname.replace(/\/$/, '') === CHAT_ENTRY.replace(/\/$/, '')
	);
	await composerHydrated(page);
	await expect(page.getByLabel('Message AI Potluck')).toBeVisible();
});
