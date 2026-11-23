// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// Two pieces of the map landing (/map) an editor builds in Payload: the Layers block, "how the map
// is organised", and the map-in-numbers figures, whose links can carry a query string.
// Which layers, what they say and where each figure links are CMS content, so the spec
// reads them from the page rather than pinning copy. It needs one figure linked to the long tail
// explorer tab, which develop's CMS has; a CMS without one fails loud, since that deep link is what
// built.

// Reduced motion keeps GSAP's ScrollSmoother off (src/lib/scroll/smooth-scroll.ts): with it on, the
// content trails the native scroll and a click lands where the button is not yet.
test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });

const LONG_TAIL = '/map/notebooks?tab=long-tail-explorer';

async function openLanding(page: Page) {
	const res = await page.goto('/map', { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `/map answered ${res?.status()}`).toBe(200);
}

test('the Layers block shows each layer with its loaded illustration and description, an arrow between layers, and a button that opens its page', async ({
	page
}) => {
	await openLanding(page);
	const block = page.locator('[data-block="layers"]').first();
	await expect(block, '/map has no Layers block').toBeVisible();
	await expect(block.locator('h2'), 'the Layers block has no title').not.toBeEmpty();

	const layers = block.locator('ol > li');
	const count = await layers.count();
	expect(count, 'the Layers block lists no layers').toBeGreaterThan(0);

	for (let i = 0; i < count; i++) {
		const layer = layers.nth(i);
		await layer.scrollIntoViewIfNeeded();
		// The illustration has to arrive, not just be in the markup: a lazy image whose upload is
		// gone renders an empty box.
		const img = layer.locator('img').first();
		await expect(img, `layer ${i + 1} has no illustration`).toBeVisible();
		await expect
			.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), {
				message: `layer ${i + 1}'s illustration did not load`,
				timeout: 15_000
			})
			.toBeGreaterThan(0);
		const description = layer.locator('article');
		await expect(description, `layer ${i + 1} has no description`).toBeVisible();
		expect(
			(await description.innerText()).trim().length,
			`layer ${i + 1}'s description is empty`
		).toBeGreaterThan(0);
		// Every layer but the last has the dotted arrow pointing up to it from the one below.
		const arrows = layer.locator('img.rotate-90');
		await expect(arrows, `layer ${i + 1}'s arrow`).toHaveCount(i < count - 1 ? 1 : 0);
	}

	const button = block.locator('a[data-slot="button"]').first();
	await expect(button, 'the Layers block has no button').toBeVisible();
	const href = (await button.getAttribute('href')) ?? '';
	expect(href, 'the Layers button links nowhere').toMatch(/^\//);
	const res = await page.request.get(href);
	expect(res.status(), `the Layers button's ${href} answered ${res.status()}`).toBe(200);
	// Centred first: scrolled only as far as the top edge, the fixed site header sits over it.
	await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await button.click();
	await expect(page).toHaveURL((url) => url.pathname + url.search + url.hash === href, {
		timeout: 20_000
	});
});

test('a map landing figure linked with a tab query opens the notebooks page on that tab', async ({
	page
}) => {
	await openLanding(page);
	const numbers = page.getByRole('region', { name: 'The map in numbers' });
	await expect(numbers, '/map has no map-in-numbers figures').toBeVisible({ timeout: 30_000 });

	const figure = numbers.locator(`dt a[href="${LONG_TAIL}"]`);
	await expect(
		figure,
		`no map landing figure links to ${LONG_TAIL}; the stat's Query field did not reach the page`
	).toHaveCount(1);
	await figure.click();
	await expect(page).toHaveURL((url) => url.pathname + url.search === LONG_TAIL, {
		timeout: 20_000
	});

	// The notebooks block selects the tab the query names once it hydrates; the server render
	// always marks the first tab, so the long tail tab being selected is the query at work.
	const notebooks = page.locator('[data-block="notebooks"]');
	const selected = notebooks.getByRole('tab', { selected: true });
	await expect(selected).toHaveCount(1, { timeout: 30_000 });
	await expect(selected, 'the query did not select the long tail explorer tab').toHaveText(
		/long tail/i,
		{ timeout: 30_000 }
	);
	const tabs = notebooks.getByRole('tab');
	expect(await tabs.first().getAttribute('aria-selected'), 'the first tab is still selected').toBe(
		'false'
	);
});
