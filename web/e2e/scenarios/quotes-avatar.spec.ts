// e2e-product: @site
import { test, expect } from './helpers/test';

// The Quotes block shows each author's avatar on its own, square, with no frame around it (CUR-2990).
// Only the home page carries a Quotes block, and not in every environment's content: where it has
// none, the test records that nothing was checked rather than passing on an assertion it never made.

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'the home page Quotes block shows each author as a square avatar image, with no frame around it',
	{ tag: '@CUR-2990' },
	async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('main')).toBeVisible();

		const section = page.locator('section[data-block="quotes"]');
		if ((await section.count()) === 0) {
			test.info().annotations.push({
				type: 'no quotes block',
				description: "this environment's home page has no Quotes block, so nothing was checked"
			});
			return;
		}

		await section.scrollIntoViewIfNeeded();
		const cards = section.locator('[data-quote-card]');
		await expect(cards.first()).toBeVisible();
		await expect(section.locator('[data-quote-frame]')).toHaveCount(0);

		const count = await cards.count();
		for (let i = 0; i < count; i++) {
			const avatar = cards.nth(i).locator(':scope > img').first();
			await expect(avatar, `card ${i + 1} has no avatar image of its own`).toBeAttached();
			const box = await avatar.evaluate((img) => img.getBoundingClientRect());
			expect(box.width, `card ${i + 1}'s avatar has no width`).toBeGreaterThan(0);
			expect(Math.abs(box.width - box.height), `card ${i + 1}'s avatar is not square`).toBeLessThan(
				1
			);
		}

		// A broken image keeps its square box, so the first card's avatar, which is on screen and so
		// past lazy loading, must also have loaded.
		const first = cards.first().locator(':scope > img').first();
		await expect
			.poll(() => first.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
			.toBe(true);
	}
);
