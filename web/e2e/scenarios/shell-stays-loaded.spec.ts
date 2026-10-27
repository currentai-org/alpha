// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';

// Mid-conversation, the whole chat shell flashed back to its first-load state for about half
// a second (CUR-2350): the side rail swapped its conversations for grey skeleton rows and the header read the
// fallback "Conversation", then both snapped back (seen in A2, A6, F2 and F6 recordings). The chat
// layout's server load read `route.id`, so every navigation between chat routes re-ran it, handed the
// shell a fresh conversations promise, and the shell showed the skeleton until it resolved.
//
// The contract: once the side rail has shown the visitor's conversations, moving around the app never
// puts it back into its loading skeleton. Walked without a model turn, by moving between a
// conversation and New chat, which crosses the same route boundary a first send does.

test.use({ viewport: { width: 1280, height: 720 } });

test(
	'once the side rail has loaded, moving between chat pages never shows its loading skeleton again',
	{ tag: '@CUR-2350' },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
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

		await page.goto(`/chat/conversation/${conversationId}`, { waitUntil: 'load' });
		const rail = page.getByRole('complementary', { name: 'Conversations' });
		const entry = rail.locator(`a[href$="/conversation/${conversationId}"]`);
		await expect(entry, 'the new conversation never appeared in the side rail').toBeVisible({
			timeout: 20_000
		});

		// Watch every DOM change from here on: the flash lasts a few hundred milliseconds, so a poll
		// could step over it. The skeleton is the only pulsing element the rail renders.
		await page.evaluate(() => {
			const w = window as unknown as { __railSkeletonSeen?: number };
			w.__railSkeletonSeen = 0;
			const railEl = document.querySelector('aside[aria-label="Conversations"]') ?? document.body;
			const check = () => {
				if (railEl.querySelector('.animate-pulse')) w.__railSkeletonSeen! += 1;
			};
			new MutationObserver(check).observe(railEl, { childList: true, subtree: true });
		});

		for (let round = 0; round < 2; round++) {
			await rail
				.getByRole('link', { name: /new chat/i })
				.first()
				.click();
			await page.waitForURL(/\/chat\/?(\?.*)?$/, { timeout: 15_000 });
			await page.waitForLoadState('networkidle');
			await entry.click();
			await page.waitForURL(new RegExp(`/conversation/${conversationId}`), { timeout: 15_000 });
			await page.waitForLoadState('networkidle');
		}

		const seen = await page.evaluate(
			() => (window as unknown as { __railSkeletonSeen?: number }).__railSkeletonSeen ?? -1
		);
		expect(
			seen,
			'the side rail went back to its loading skeleton after it had already shown the conversations'
		).toBe(0);
		await expect(entry, 'the conversation dropped out of the side rail').toBeVisible();
	}
);
