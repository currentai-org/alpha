import { expect, type Page } from '@playwright/test';

/**
 * Every product the full dataset lists, read from the page itself so a search test is not pinned to
 * a catalog value. The dataset renders a category's rows as it nears the screen, so this opens it
 * in its own tab and scrolls down until no category is left unrendered. `bucket` is the openness
 * bucket (open, open-ish or closed); `org` is set when the org has a page.
 */
export async function datasetRows(page: Page) {
	const tab = await page.context().newPage();
	try {
		await tab.goto('/map/dataset', { waitUntil: 'domcontentloaded' });
		await expect(tab.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(1, {
			timeout: 30_000
		});
		const unrendered = tab.locator('tr[data-rows-pending]');
		for (let i = 0; i < 80 && (await unrendered.count()) > 0; i++) {
			await tab.evaluate(() => window.scrollBy({ top: 2500, behavior: 'instant' }));
			await tab.waitForTimeout(100);
		}
		await expect(unrendered, 'every category rendered its rows').toHaveCount(0);
		return await tab.locator('tr[data-product-id]').evaluateAll((rows) =>
			rows.map((r) => ({
				name: r.querySelector('[data-testid="product-name"]')?.textContent?.trim() ?? '',
				bucket: r.getAttribute('data-bucket') ?? '',
				org: r.querySelector('a[href^="/org/"]')?.textContent?.trim() ?? null
			}))
		);
	} finally {
		await tab.close();
	}
}
