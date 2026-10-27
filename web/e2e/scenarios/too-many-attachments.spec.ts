// e2e-product: @chat
// e2e-area: @turn
// A turn accepted any number of file parts (CUR-3530). Long pastes are left out of the byte cap, so a
// request under the platform body limit could carry hundreds of them, each one a storage write. The
// spec starts a real chat, then posts that conversation a turn with one paste over the count, the way
// a script would, and expects the 413 and the sentence a person would read.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';

const MAX_FILES = 10; // CHAT_ATTACHMENTS_MAX_COUNT in web/src/lib/chat/constants/uploadLimits.ts

test(
	'a turn carrying more files than the per-message count is refused before anything is stored',
	{ tag: ['@CUR-3530'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What can you help me with?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const convPath = new URL(page.url()).pathname;
		// A turn sent while the first is still saving is refused on its own account (CUR-2667).
		await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
			timeout: 60_000
		});

		const form = new FormData();
		form.set('data', JSON.stringify({ inputs: 'hi' }));
		for (let i = 0; i <= MAX_FILES; i++) {
			const text = Buffer.from(`paste ${i} `.repeat(20)).toString('base64');
			form.append(
				'files',
				new File([text], 'base64;Pasted Content', { type: 'application/vnd.chatui.clipboard' })
			);
		}
		const response = await page.request.post(convPath, {
			multipart: form,
			// The chat's CSRF hook checks Origin; send the page's own, as its fetch would.
			headers: { origin: new URL(page.url()).origin }
		});
		expect(
			response.status(),
			`a turn with ${MAX_FILES + 1} pasted files was not refused for its count`
		).toBe(413);
		expect(await response.text()).toContain(`up to ${MAX_FILES} files`);
	}
);
