// e2e-product: @site
import { test, expect } from './helpers/test';

// On a phone, /contribute's "Our momentum is building" (the Text & Updates block) is set at the same
// size as "How to get involved" (the Contribute Paths block). From md up the Text &
// Updates heading steps down to the subsection size by design, so only phone width is held equal.
// The headings are read by block rather than by copy, since the CMS owns their text.

test.use({ viewport: { width: 390, height: 844 } });

test('at phone width the Text & Updates heading on /contribute matches the Contribute Paths heading size', async ({
	page
}) => {
	await page.goto('/contribute');
	const momentum = page.locator('[data-block="text-updates"] h2').first();
	const involved = page.locator('[data-block="contribute-paths"] h2').first();
	await expect(momentum, '/contribute has no Text & Updates heading').toBeVisible();
	await expect(involved, '/contribute has no Contribute Paths heading').toBeVisible();

	const size = (el: typeof momentum) =>
		el.evaluate((h) => parseFloat(getComputedStyle(h).fontSize));
	const [a, b] = [await size(momentum), await size(involved)];
	expect(
		a,
		`"${await momentum.innerText()}" is ${a}px, "${await involved.innerText()}" is ${b}px`
	).toBeCloseTo(b, 1);
});
