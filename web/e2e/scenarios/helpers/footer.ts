import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Scrolls to the bottom of the page and waits until `target` (something in the site footer) has held
 * still on screen, clear of the fixed site header, for one poll (CUR-4492).
 *
 * ScrollSmoother lags the footer (`data-smooth-footer`) and glides the page for about a second after
 * a native scroll, so a link's painted position trails its layout box. Playwright's own
 * scroll-into-view then lands it under the fixed header, its retries cycle scroll alignments, and the
 * header takes every click until the test times out. ScrollSmoother also starts after the page loads
 * and puts the page back at its own scroll position, undoing an earlier scroll, so each poll scrolls
 * again. On a page or device without smoothing the first two polls settle it.
 */
export async function scrollFooterToRest(page: Page, target: Locator): Promise<void> {
	const viewportHeight = page.viewportSize()?.height ?? 720;
	let lastTop: number | undefined;
	await expect
		.poll(
			async () => {
				await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				const box = await target.boundingBox();
				const headerBottom = await page
					.locator('header[data-site-header]')
					.evaluate((el) => el.getBoundingClientRect().bottom)
					.catch(() => 0);
				const settled =
					!!box &&
					box.y === lastTop &&
					box.y >= headerBottom &&
					box.y + box.height <= viewportHeight;
				lastTop = box?.y;
				return settled;
			},
			{
				message: 'the footer never came to rest on screen below the site header',
				intervals: [250],
				timeout: 15_000
			}
		)
		.toBe(true);
}
