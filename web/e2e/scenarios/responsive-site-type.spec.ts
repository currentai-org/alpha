// e2e-product: @site
import { test, expect } from './helpers/test';

// The site's type scales with the window (#2301). The home page's hero title uses
// `--text-clamp-display`, clamp(2.75rem, 1.992rem + 3.37vw, 4.5rem): 44px at its floor and about 45px
// on a 390px phone. It reaches its 72px cap at about 1,240px. Rich-text body copy is text-base
// (16px) below 64rem and text-lg (18px) from 64rem (`.richtext` in app.css). Both are read as
// rendered at a phone and a desktop width, so a page that pins its own sizes, or a token that
// changes, shows up here.

const REM = 16;

/** The hero title's size at a given window width, from the same clamp the token sets. */
const displaySize = (vw: number) =>
	Math.min(4.5 * REM, Math.max(2.75 * REM, 1.992 * REM + 0.0337 * vw));

const WIDTHS = [
	{ name: 'phone', width: 390, height: 844, body: 1 * REM },
	{ name: 'desktop', width: 1280, height: 800, body: 1.125 * REM }
];

for (const { name, width, height, body } of WIDTHS) {
	test.describe(`${name} width (${width}px)`, () => {
		test.use({ viewport: { width, height } });

		test(`the home page title renders at the display clamp's size for a ${width}px window`, async ({
			page
		}) => {
			const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
			expect(res?.status(), '/ did not load').toBe(200);
			const h1 = page.locator('main h1').first();
			await expect(h1, 'the home page has no title').toBeVisible();

			const { size, rem, innerWidth } = await h1.evaluate((el) => ({
				size: parseFloat(getComputedStyle(el).fontSize),
				rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
				innerWidth: window.innerWidth
			}));
			expect(rem, 'the root font size is not 16px, so every rem size below is off').toBe(REM);
			expect(size, 'the home title is below the 44px floor').toBeGreaterThanOrEqual(
				2.75 * REM - 0.5
			);
			expect(
				size,
				`the home title is ${size}px where the display clamp gives ${displaySize(innerWidth).toFixed(1)}px at ${innerWidth}px`
			).toBeCloseTo(displaySize(innerWidth), 0);
		});

		test(`roadmap rich text with no size of its own renders at ${body}px`, async ({ page }) => {
			const res = await page.goto('/roadmap', { waitUntil: 'domcontentloaded' });
			expect(res?.status(), '/roadmap did not load').toBe(200);
			await expect(page.locator('main .richtext').first()).toBeVisible();

			// A component may size its rich text with a utility on the wrapper (`text-sm` on cards), and
			// that wins on purpose. Only a wrapper with no size utility of its own shows the body default.
			const sizes = await page.locator('main .richtext').evaluateAll((els) =>
				els
					.filter((el) => !/(^|\s)(\w+:)*text-(xs|sm|base|lg|xl|\d)/.test(el.className))
					.filter((el) => el.getBoundingClientRect().height > 0)
					.map((el) => parseFloat(getComputedStyle(el).fontSize))
			);
			expect(sizes.length, 'no rich text on /roadmap is left at the body default').toBeGreaterThan(
				0
			);
			for (const size of sizes) {
				expect(size, `rich-text body is ${size}px at ${width}px, expected ${body}px`).toBe(body);
			}
		});
	});
}
