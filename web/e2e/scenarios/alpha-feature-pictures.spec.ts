// e2e-product: @site
import { expect, test } from './helpers/test';

// The /alpha landing shows Alpha's features as pictures of the app, not by running chat's components,
// so the site needs none of chat's code. Each card keeps a live heading and line of copy, and its scene
// is a picture captured in the visitor's language. The theme and instructions cards still run live:
// they are the site's own components.

const PICTURES = ['language', 'data', 'footprint', 'model', 'xray'];

for (const locale of ['en', 'de']) {
	test(`every /alpha feature card shows its heading and, in ${locale}, its picture`, async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, url: baseURL! }]);
		const response = await page.goto(locale === 'en' ? '/alpha' : `/${locale}/alpha`);
		expect(response?.status()).toBe(200);

		const cards = page.locator('article[data-bento]');
		await expect(cards).toHaveCount(7);
		for (const card of await cards.all()) {
			await card.scrollIntoViewIfNeeded();
			await expect(card.locator('h3')).toHaveText(/\S/);
		}

		for (const name of PICTURES) {
			const picture = page.locator(`img[data-feature-picture="${name}"]`);
			await expect(picture, name).toHaveCount(1);
			await picture.scrollIntoViewIfNeeded();
			await expect(picture, name).toHaveAttribute('src', `/alpha-features/${name}.${locale}.webp`);
			// Loaded, not a broken image: the browser decoded real pixels.
			await expect
				.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), {
					message: `${name} picture loads`
				})
				.toBeGreaterThan(0);
		}
	});
}

test('the /alpha hero draws the Potluck mark from the site favicon', async ({ page, request }) => {
	await page.goto('/alpha');
	const glyph = page.locator('.potluck-glyph').first();
	await expect(glyph).toBeVisible();
	const mask = await glyph.evaluate(
		(el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage
	);
	expect(mask).toContain('/favicon.svg');
	expect((await request.get('/favicon.svg')).status()).toBe(200);
});
