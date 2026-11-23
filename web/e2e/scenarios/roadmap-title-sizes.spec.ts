// e2e-product: @site
import { test, expect } from './helpers/test';

// The roadmap's section titles are one size. The timeline block's title ("5 key launches
// to releasing Alpha" when the ticket was filed) was set larger than the epic listings' titles
// ("Private Beta to Make AI yours"), and #4278 put the timeline on the same `text-clamp-section` step.
// The check reads the rendered size, so a change to either block's type or to the step itself shows
// up here. Titles are found by their block. Editors rename them, so the copy is never matched.

const WIDTHS = [
	{ name: 'desktop', width: 1280, height: 800 },
	{ name: 'mobile', width: 390, height: 844 }
];

for (const { name, width, height } of WIDTHS) {
	test.describe(`${name} width`, () => {
		test.use({ viewport: { width, height } });
		test(`on /roadmap at ${name} width, the timeline title renders at the same font size as every epic listing title`, async ({
			page
		}) => {
			const res = await page.goto('/roadmap', { waitUntil: 'domcontentloaded' });
			expect(res?.status(), '/roadmap did not load').toBe(200);

			const timelineTitle = page.locator('[data-block="timeline"] h2').first();
			const epicTitles = page.locator('[data-block="epic-listing"] h2');
			await expect(timelineTitle, 'the roadmap has no timeline block with a title').toBeVisible();
			await expect(
				epicTitles.first(),
				'the roadmap has no epic listing block with a title'
			).toBeVisible();

			const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
			const timelineSize = await timelineTitle.evaluate(size);
			const epicSizes = await epicTitles.evaluateAll((els) =>
				els.map((el) => parseFloat(getComputedStyle(el).fontSize))
			);

			expect(timelineSize, 'the timeline title has no computed font size').toBeGreaterThan(0);
			for (const [i, epicSize] of epicSizes.entries()) {
				expect(
					epicSize,
					`epic listing title ${i + 1} is ${epicSize}px while the timeline title is ${timelineSize}px`
				).toBeCloseTo(timelineSize, 1);
			}
		});
	});
}
