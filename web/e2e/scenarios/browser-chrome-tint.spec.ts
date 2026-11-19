// e2e-product: @chat
// e2e-area: @settings
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';

// Mobile Safari tints its address bar and toolbar from the page's root background (Safari 26) or the
// theme-color meta (earlier Safari, Chrome on Android). The chat window is dark by default while
// <html> is light for the site, so without this the bars around a dark chat stay white.
test.use({ colorScheme: 'dark' });

test('the root background and theme-color follow the dark chat window, so the browser bars are dark too', async ({
	page
}) => {
	await page.goto(chatEntry());
	const chatWindow = page.locator('.chat-window.ds-root').first();
	await expect(chatWindow).toBeVisible();

	const read = () =>
		page.evaluate(() => {
			const win = document.querySelector<HTMLElement>('.chat-window.ds-root');
			return {
				ground: win ? getComputedStyle(win).backgroundColor : null,
				root: getComputedStyle(document.documentElement).backgroundColor,
				scheme: document.documentElement.style.colorScheme,
				meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
			};
		});

	// Wait for the paint to match the dark ground, not just for any paint: an early read of the light
	// ground also turns the root opaque.
	await expect
		.poll(async () => {
			const s = await read();
			return s.ground !== null && s.root === s.ground && s.meta === s.ground;
		})
		.toBe(true);
	const seen = await read();
	expect(seen.ground).toBeTruthy();
	expect(seen.root).toBe(seen.ground);
	expect(seen.meta).toBe(seen.ground);
	expect(seen.scheme).toBe('dark');
});
