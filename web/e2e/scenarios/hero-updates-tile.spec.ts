// e2e-product: @site
import { test, expect } from './helpers/test';

// The homepage hero's recent-updates tile hovers with the same three-column wipe as the
// site's buttons (blocks/button/sweep-blocks.svelte), filling white and turning its text dark blue.

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'hovering the hero updates tile runs the same wipe as the buttons and turns its text dark blue',
	{ tag: '@CUR-2963' },
	async ({ page }) => {
		await page.goto('/');
		const tile = page.locator('[data-block="recent-updates"]');
		// A cold render that waits more than 1s on the CMS serves an empty window and the tile hides by
		// design (CUR-2254); the fetch still warms the cache, so reload until it answers, as
		// project-is-active.spec.ts does (CUR-3700). The hover contract is what this spec checks.
		if (!(await tile.isVisible())) {
			test.info().annotations.push({
				type: 'cold-render',
				description:
					'the first render of / served the updates fallback; reloaded until the CMS answer was cached'
			});
			await expect(async () => {
				await page.reload();
				await expect(tile).toBeVisible({ timeout: 2_000 });
			}).toPass({ timeout: 20_000 });
		}
		await expect(tile).toBeVisible({ timeout: 5_000 });
		const columns = tile.locator('span[aria-hidden="true"] > span');
		await expect(columns, 'the tile has no wipe columns').toHaveCount(3);
		// Each column grows from nothing to the tile's full height (Tailwind's scale-y-* sets the
		// `scale` property, not `transform`, so this reads the rendered boxes instead).
		const heights = () =>
			tile.evaluate((el) => {
				const tileHeight = el.getBoundingClientRect().height;
				return [...el.querySelectorAll('span[aria-hidden="true"] > span')].map(
					(c) => Math.round((c.getBoundingClientRect().height / tileHeight) * 100) / 100
				);
			});
		expect(await heights(), 'the wipe already covers the tile before hovering').toEqual([0, 0, 0]);
		await tile.hover();
		await expect
			.poll(async () => (await heights()).every((h) => h >= 1), {
				message: 'the wipe never filled the tile'
			})
			.toBe(true);
		await expect(tile.getByText(/Updates?$/)).toHaveCSS('color', 'rgb(20, 46, 62)');
	}
);
