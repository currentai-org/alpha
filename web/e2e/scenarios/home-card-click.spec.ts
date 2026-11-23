// e2e-product: @site
import { test, expect } from './helpers/test';

// The homepage cards (Cards block: the product cards and the Join us cards) act as their first
// button: a click on a card's text, heading or picture does what clicking its first button does.
// Which cards carry which buttons is CMS content, so the spec reads each card's first button from
// the page and checks every card whose first button is a same-tab link inside the site.

test.use({ viewport: { width: 1280, height: 800 } });

test('a click on a homepage card’s text or picture opens its first button’s page', async ({
	page
}) => {
	await page.goto('/');
	const cards = page.locator('[data-card]');
	await expect(cards.first(), 'the homepage shows no cards').toBeVisible();

	// [card index, heading, first button's path] for every card whose first button is a same-tab
	// link to a page of this site.
	const targets = await cards.evaluateAll((els) =>
		els.flatMap((el, i) => {
			const a = el.querySelector<HTMLAnchorElement>('[data-card-buttons] a[href]');
			if (!a || (a.target && a.target !== '_self')) return [];
			const url = new URL(a.href, location.href);
			if (url.origin !== location.origin) return [];
			const heading = el.querySelector('h3')?.textContent?.trim() ?? '';
			return [[i, heading, url.pathname] as const];
		})
	);
	expect(
		targets.length,
		'no homepage card has a first button linking inside the site'
	).toBeGreaterThan(0);

	for (const [i, heading, path] of targets) {
		await page.goto('/');
		const card = cards.nth(i);
		await card.scrollIntoViewIfNeeded();
		// Wait out the reveal fade, so the click lands on the card where it rests.
		await expect(card).toHaveCSS('opacity', '1');
		await expect(card, `card "${heading}" does not show a pointer`).toHaveCSS('cursor', 'pointer');
		// The card's body text, away from its buttons: neither a link nor a button.
		const body = card.locator('h3');
		await body.click();
		await expect(page, `clicking card "${heading}" did not open ${path}`).toHaveURL(
			(url) => url.pathname === path
		);
	}
});

test('clicking a homepage card’s own button still opens its page once', async ({ page }) => {
	await page.goto('/');
	const button = page.locator('[data-card] [data-card-buttons] a[href="/contribute"]').first();
	await expect(button, 'no homepage card has a button to /contribute').toBeVisible();
	const navigations: string[] = [];
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname);
	});
	await button.click();
	await expect(page).toHaveURL(/\/contribute$/);
	await expect(page.locator('[data-path]').first()).toBeVisible();
	expect(navigations.filter((p) => p === '/contribute')).toHaveLength(1);
});
