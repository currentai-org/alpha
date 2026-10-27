// e2e-product: @chat
// e2e-area: @settings
// A3 row 14 (docs/journeys/a3-my-data.md). Memory across chats is not built (CUR-1016). What A3
// promises today is that nothing pretends otherwise: Settings → Personalization names memory as
// "Coming soon", and none of its controls takes a choice it would then ignore (CUR-1060).
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';
import { holdForRecording } from './helpers/recording';
import { setFlagOverrides } from './helpers/flagOverride';

test(
	'memory is marked Coming soon in Personalization, and none of its controls can be used',
	{ tag: '@A3' },
	async ({ page, context, baseURL }) => {
		// Past-chat search is the one memory control that works, behind its own flag. With the
		// flag off, the whole section stays Coming soon.
		await setFlagOverrides(context, baseURL!, { 'past-chat-search': false });
		await page.addLocatorHandler(
			page.getByRole('dialog', { name: /Welcome to Alpha/ }),
			async (d) => {
				await d.getByRole('button', { name: /start chatting/i }).click();
			}
		);
		await signInAsFreshUser(page);
		await journeyStep(page, 'A3', 14, async () => {
			await page.goto('/chat/settings/personalization', { waitUntil: 'load' });
			const heading = page.getByRole('heading', { name: /Alpha memory/ });
			await expect(heading, 'Personalization has no memory section').toBeVisible({
				timeout: 15_000
			});
			await expect(heading, 'memory is not marked as not built yet').toContainText('Coming soon');
			for (const name of [
				'Remember things from my chats (coming soon)',
				'Include chats that used web search (coming soon)'
			]) {
				const control = page.getByRole('switch', { name });
				await expect(control, `"${name}" takes a choice memory would ignore`).toBeDisabled();
				await expect(control, `"${name}" reads as switched on`).not.toBeChecked();
			}
			await expect(
				page.getByRole('button', { name: 'Delete', exact: true }),
				'Delete memories is live with nothing to delete'
			).toBeDisabled();
			await heading.scrollIntoViewIfNeeded();
			await holdForRecording(page);
		});
	}
);
