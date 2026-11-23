// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// The Updates template: the Roadmap-style hero with its light Progress panel, then the
// list of updates under a row of category filter tags, paged at `<listing>/page/<n>` with the
// filter's `?category=` carried onto every page.
//
// Which categories exist and how many updates each holds is CMS content, so the spec reads both from
// the page rather than pinning them. It needs one category with more than a page of updates, which
// develop's CMS has; a CMS without one fails loud, since the paged filter is what this ticket built.

test.use({ viewport: { width: 1280, height: 900 } });

const rows = (page: Page) => page.locator('main a[data-update-row]');
const filterNav = (page: Page) =>
	page.getByRole('navigation', { name: 'Filter updates by category' });
const pagesNav = (page: Page) => page.getByRole('navigation', { name: 'Updates pages' });
const progressPanel = (page: Page) =>
	page.locator('main [data-component="stats-panel"][data-tone="light"]');

/** Each row's link and the category its icon names (the icon's alt is the category, label or not). */
async function listed(page: Page): Promise<{ href: string; category: string }[]> {
	return rows(page).evaluateAll((els) =>
		els.map((el) => ({
			href: el.getAttribute('href') ?? '',
			category: el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') ?? ''
		}))
	);
}

/** Open `path` and wait for its list, reloading past a cold render that served no updates. */
async function openListing(page: Page, path: string) {
	await page.goto(path);
	await expect(async () => {
		if ((await rows(page).count()) === 0) await page.reload();
		await expect(rows(page).first()).toBeAttached({ timeout: 3_000 });
	}, `${path} listed no updates`).toPass({ timeout: 20_000 });
}

test('the updates page shows its hero and a Progress panel whose update count is every listed update', async ({
	page
}) => {
	await openListing(page, '/updates');
	await expect(page.locator('main h1')).toBeVisible();
	const panel = progressPanel(page);
	await expect(panel, 'the hero has no light Progress panel beside it').toBeVisible();

	// Page 1 of the unfiltered list opens with the featured latest update, then rows.
	await expect(rows(page).first()).toHaveAttribute('data-update-row', 'featured');

	// The panel's first figure is the live count of published updates (updatesFigures): walk
	// every page of the unfiltered list and count what it lists.
	const figure = Number(await panel.locator('.count-up + .sr-only').first().textContent());
	// The highest numbered page link is the last page; a list that fits one page has no nav.
	const totalPages = (await pagesNav(page).isVisible())
		? Number(
				(
					await pagesNav(page)
						.locator('a[aria-label^="Page "], [aria-current="page"]')
						.last()
						.textContent()
				)?.trim()
			)
		: 1;
	const hrefs = new Set((await listed(page)).map((r) => r.href));
	for (let n = 2; n <= totalPages; n++) {
		await openListing(page, `/updates/page/${n}`);
		for (const r of await listed(page)) hrefs.add(r.href);
	}
	expect(figure, 'the Progress panel shows no update count').toBeGreaterThan(0);
	expect(
		hrefs.size,
		'the Progress panel count differs from the updates the list pages through'
	).toBe(figure);
});

test('a category filter narrows the list to that category, and its page 2 keeps the filter', async ({
	page
}) => {
	await openListing(page, '/updates');
	const all = await listed(page);
	expect(
		new Set(all.map((r) => r.category)).size,
		'page 1 of all updates holds one category only, so no filter could narrow it'
	).toBeGreaterThan(1);

	const tags = filterNav(page).getByRole('link').filter({ visible: true });
	// textContent, not innerText: the tags are uppercased by CSS, the icons' alts are not.
	const names = (await tags.allTextContents())
		.map((t) => t.trim())
		.filter((t) => t !== 'All updates');
	expect(names.length, 'the updates page offers no category filter').toBeGreaterThan(0);

	// Pick the first category with more than one page, by clicking its tag as a visitor would.
	let chosen: string | null = null;
	for (const name of names) {
		const tag = filterNav(page).getByRole('link', { name, exact: true }).filter({ visible: true });
		const href = (await tag.getAttribute('href'))!;
		expect(href, `the ${name} tag does not link to a category filter`).toMatch(/\?category=/);
		await tag.click();
		await expect(page).toHaveURL((url) => url.pathname + url.search === href);
		await expect(tag).toHaveAttribute('aria-current', 'true');
		await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
		const shown = await listed(page);
		expect(shown.length, `the ${name} filter lists nothing`).toBeGreaterThan(0);
		expect(
			shown.filter((r) => r.category !== name),
			`the ${name} filter still lists other categories' updates`
		).toEqual([]);
		if (await pagesNav(page).isVisible()) {
			chosen = name;
			break;
		}
	}
	expect(chosen, 'no category holds more than one page of updates in this CMS').not.toBeNull();

	const slug = new URL(page.url()).searchParams.get('category')!;
	const firstPage = new Set((await listed(page)).map((r) => r.href));
	await pagesNav(page).locator('a[rel="next"]').click();
	await expect(page).toHaveURL(
		new RegExp(`/updates/page/2\\?category=${encodeURIComponent(slug)}$`)
	);
	await expect(pagesNav(page).locator('[aria-current="page"]')).toHaveText('2');
	await expect(
		filterNav(page).locator('a[aria-current="true"]').filter({ visible: true })
	).toHaveText(chosen!);
	await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);

	const secondPage = await listed(page);
	expect(secondPage.length, 'page 2 of the filter lists nothing').toBeGreaterThan(0);
	expect(
		secondPage.filter((r) => r.category !== chosen),
		'page 2 dropped the category filter'
	).toEqual([]);
	expect(
		secondPage.filter((r) => firstPage.has(r.href)),
		'page 2 repeats updates from page 1'
	).toEqual([]);
	// The hero and its panel stay on every page of the list.
	await expect(page.locator('main h1')).toBeVisible();
	await expect(progressPanel(page)).toBeVisible();

	await pagesNav(page).locator('a[rel="prev"]').click();
	await expect(page).toHaveURL(new RegExp(`/updates\\?category=${encodeURIComponent(slug)}$`));
});
