// e2e-product: @chat
// e2e-area: @turn
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// A first-time visitor's Welcome to Alpha card painted in fallback faces, then rewrapped about a
// second later when Plus Jakarta Sans and Noto Serif arrived (the card's body went from three lines to
// two). The faces came through a Google Fonts @import,
// and a browser fetches a face only once text needing it is on screen, so a card rendered on the
// client always drew its first frame before its fonts.
//
// The contract (CUR-2385): the first frame the card is on screen is already drawn in its own faces. Checked over
// a slow connection, because on a fast one the fonts win the race by luck and the defect hides.

test.use({ viewport: { width: 1280, height: 720 } });

// Throttled with CDP below, which a cached, route-fulfilled asset would skip (helpers/test.ts).
test.use({ cacheStaticAssets: false });

// Render the chat entry once off the browser before the test throttles it, so a first request to a
// fresh deployment is not part of the card's wait (a cold first request can time
// out with no card and pass on retry). A hook of its own, so the warm-up has its own budget
// and the test keeps its 90 s. A separate request context shares no HTTP cache with the page, so the
// fonts still load cold.
test.beforeAll(async ({ playwright }, testInfo) => {
	testInfo.setTimeout(75_000);
	const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
	const warmStart = Date.now();
	const warm = await api.get(chatEntry(), { timeout: 60_000 });
	console.log(`warm chat entry: ${warm.status()} in ${Date.now() - warmStart} ms`);
	await api.dispose();
});

test(
	"the Welcome to Alpha card's first frame is already in its own fonts, even on a slow connection",
	{ tag: '@CUR-2385' },
	async ({ page: firstPage, context }) => {
		test.setTimeout(90_000);

		// Record the font state on the first animation frame the heading exists, before anything can
		// settle. A later read would pass on a page that had already swapped. On the context, so a
		// second page below gets it too.
		await context.addInitScript(() => {
			const w = window as unknown as { __firstPaintFonts?: Record<string, boolean> };
			const tick = () => {
				// The dialog's title is a level-1 heading by role (bits-ui renders it as a div), not an h1.
				const heading = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')].find(
					(h) =>
						h.textContent?.trim() === 'Welcome to Alpha' && h.getBoundingClientRect().height > 0
				);
				if (!heading) return requestAnimationFrame(tick);
				w.__firstPaintFonts = {
					'Noto Serif': document.fonts.check('32px "Noto Serif"', 'Welcome to Alpha'),
					'Plus Jakarta Sans': document.fonts.check('16px "Plus Jakarta Sans"', 'An AI assistant')
				};
			};
			requestAnimationFrame(tick);
		});

		const open = async (page: Page) => {
			const cdp = await context.newCDPSession(page);
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 150,
				downloadThroughput: 200 * 1024,
				uploadThroughput: 100 * 1024
			});
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			try {
				await page
					.getByRole('dialog', { name: 'Welcome to Alpha' })
					.waitFor({ state: 'visible', timeout: 30_000 });
				return true;
			} catch {
				// Under the emulated slow network Chromium can hand none of the page's script responses to the page
				// in 60s even though the server answered each with a 200 inside a second. That is
				// a browser stall, not a page that failed to show
				// the card, so it is told apart by whether any of the app's own scripts finished arriving.
				const scripts = await page.evaluate(
					() =>
						performance
							.getEntriesByType('resource')
							.filter((e) => /\/_app\/immutable\/.*\.js$/.test(new URL(e.name).pathname)).length
				);
				return scripts > 0;
			}
		};

		let page = firstPage;
		if (!(await open(page))) {
			test.info().annotations.push({
				type: 'throttle stall',
				description:
					'none of the app scripts arrived under the emulated network; reloaded in a new tab'
			});
			await page.close();
			page = await context.newPage();
			expect(
				await open(page),
				'none of the app scripts arrived under the emulated slow network, twice; the page never started'
			).toBe(true);
		}
		await expect(
			page.getByRole('dialog', { name: 'Welcome to Alpha' }),
			'a fresh visitor was not shown the Welcome to Alpha card'
		).toBeVisible({ timeout: 60_000 });

		const fonts = await page.evaluate(
			() => (window as unknown as { __firstPaintFonts?: Record<string, boolean> }).__firstPaintFonts
		);
		expect(fonts, 'the heading was never seen by the first-frame probe').toBeTruthy();
		expect(
			fonts,
			'the Welcome to Alpha card painted before its fonts had loaded, so it rewraps a moment later'
		).toEqual({ 'Noto Serif': true, 'Plus Jakarta Sans': true });
	}
);
