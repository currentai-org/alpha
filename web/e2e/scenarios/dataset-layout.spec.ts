// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';

// The full dataset view. Every layer is stacked on one page under the gap map's layer
// bar, each category a row that expands into its products. It lists closed products as well as
// open and open-ish ones, so its legend explains all three types where the gap map's explains only
// the two it draws. Counts are asserted by shape, not value: they change on every rescore.

const DATASET = '/map/dataset';

async function openDataset(page: Page, query = '') {
	const res = await page.goto(DATASET + query, { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `${DATASET} answered ${res?.status()}`).toBe(200);
	await expect(page.getByTestId('map-header')).toBeVisible({ timeout: 30_000 });
	// The layer bar marks a tab active only from client code, so a marked tab means the page has
	// hydrated and a click will land.
	await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(1, {
		timeout: 30_000
	});
}

/** Hover without a scroll during the hover: tooltips hide on scroll. */
async function hoverSettled(target: Locator) {
	await target.evaluate(
		(el) =>
			new Promise<void>((done) => {
				el.scrollIntoView({ block: 'center', behavior: 'instant' });
				requestAnimationFrame(() => requestAnimationFrame(() => done()));
			})
	);
	await target.hover();
}

const filterButton = (page: Page, name: string) =>
	page
		.getByRole('group', { name: 'Filter by openness' })
		.getByRole('button', { name, exact: true });

/** The product names in a category's table, top to bottom. */
const productNames = (category: Locator) =>
	category
		.locator('[data-testid="product-name"]')
		.evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));

test.describe('dataset layout, desktop', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the legend is the gap map's, explaining every openness type including Closed, with no floating legend", async ({
		page
	}) => {
		await openDataset(page);
		await expect(page.getByRole('button', { name: /expand legend|collapse legend/i })).toHaveCount(
			0
		);
		await expect(
			page.getByTestId('layer-bar').getByRole('button', { name: 'How to read the map' })
		).toBeVisible();

		const dialog = page.getByRole('dialog', { name: 'How to read the map' });
		await page.getByRole('button', { name: 'How to read the map' }).click();
		await expect(dialog).toBeVisible();

		await expect(dialog).toContainText('Maturity stage:');
		await expect(dialog).toContainText(
			'Every product is assessed with an openness score, and is typed as Open Source, Open-ish or closed.'
		);
		await expect(dialog).not.toContainText('This map only shows the first 2 types.');
		await expect(dialog.getByText('Closed', { exact: true })).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	});

	test('all three layers are stacked on one page in Product / UX, Model, Infrastructure order, with no tab list', async ({
		page
	}) => {
		await openDataset(page);
		const ids = await page.locator('section[id^="layer-"]').evaluateAll((s) => s.map((e) => e.id));
		expect(ids).toEqual(['layer-product_ux', 'layer-model_components', 'layer-infrastructure']);
		await expect(page.getByRole('tablist')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^sort by/i })).toHaveCount(0);
	});

	test('no openness filter is on by default, and closed products are listed', async ({ page }) => {
		await openDataset(page);
		for (const name of ['Open', 'Open-ish', 'Closed'])
			await expect(filterButton(page, name)).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByRole('cell', { name: 'closed', exact: true }).first()).toBeVisible();
	});

	test('every category opens expanded, and Collapse all closes its own layer only, then Expand all reopens it', async ({
		page
	}) => {
		await openDataset(page);
		const layer = page.locator('#layer-product_ux');
		const rows = layer.locator('[aria-expanded]');
		const count = await rows.count();
		expect(count).toBeGreaterThan(1);
		await expect(layer.locator('[aria-expanded="true"]')).toHaveCount(count);

		await layer.getByRole('button', { name: 'Collapse all' }).click();
		await expect(layer.locator('[aria-expanded="true"]')).toHaveCount(0);
		await expect(layer.locator('table')).toHaveCount(0);
		await expect(page.locator('#layer-infrastructure [aria-expanded="false"]')).toHaveCount(0);

		await layer.getByRole('button', { name: 'Expand all' }).click();
		await expect(layer.locator('[aria-expanded="true"]')).toHaveCount(count);
	});

	test('a category row toggles its own table', async ({ page }) => {
		await openDataset(page);
		const category = page.locator('#layer-model_components [aria-expanded]').first();
		const table = page.locator('#layer-model_components table').first();
		await expect(table).toBeVisible();
		await category.click();
		await expect(category).toHaveAttribute('aria-expanded', 'false');
		await category.click();
		await expect(category).toHaveAttribute('aria-expanded', 'true');
	});

	test('product names line up with the category name above them', async ({ page }) => {
		await openDataset(page);
		const cat = page.locator('#layer-product_ux [data-testid="category-label"]').first();
		const prod = page.locator('#layer-product_ux [data-testid="product-name"]').first();
		const [cx, px] = await Promise.all(
			[cat, prod].map((l) => l.evaluate((e) => e.getBoundingClientRect().left))
		);
		expect(Math.abs(cx - px)).toBeLessThan(2);
	});

	test('the gaps column is as wide in every row, wide enough for the most gaps any category has', async ({
		page
	}) => {
		await openDataset(page);
		const gaps = page.locator('[data-testid="category-gaps"]');
		const widths = await gaps.evaluateAll((els) => [
			...new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)))
		]);
		expect(widths).toHaveLength(1);
		const overflow = await gaps.evaluateAll((els) =>
			els.some((e) => e.scrollWidth > e.clientWidth)
		);
		expect(overflow).toBe(false);
		// The labels start at one x on every row, across all three layers.
		const labelXs = await page
			.locator('[data-testid="category-label"]')
			.evaluateAll((els) => [
				...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))
			]);
		expect(labelXs).toHaveLength(1);
	});

	test('the table columns line up from one category to the next', async ({ page }) => {
		await openDataset(page);
		const lefts = await page
			.locator('section[id^="layer-"] table')
			.evaluateAll((tables) =>
				tables.map((t) =>
					[...t.querySelectorAll('thead th')]
						.map((th) => Math.round(th.getBoundingClientRect().left))
						.join(',')
				)
			);
		expect(lefts.length).toBeGreaterThan(1);
		expect(new Set(lefts).size).toBe(1);
	});

	test('the table header is set like the gap map column headers, and sticks under the layer bar', async ({
		page
	}) => {
		await openDataset(page);
		const th = page.locator('#layer-model_components thead th').first();
		const style = await th.evaluate((e) => {
			const s = getComputedStyle(e);
			return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight };
		});
		expect(style.family).toMatch(/Plus Jakarta/);
		expect(style).toMatchObject({ size: '14px', weight: '600' });
		await expect(th).toHaveAttribute('data-sticky-header');

		// Scroll into the middle of the first category's table: its header pins under the bar.
		const table = page.locator('#layer-model_components table').first();
		await table.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2)
		);
		const bar = await page.getByTestId('layer-bar').boundingBox();
		await expect.poll(async () => (await th.boundingBox())?.y).toBeCloseTo(bar!.y + bar!.height, 0);
	});

	test('organisation names are not underlined until hovered', async ({ page }) => {
		await openDataset(page);
		const org = page.locator('#layer-product_ux table a[href^="/org/"]').first();
		expect(await org.evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('none');
		await org.hover();
		await expect
			.poll(() => org.evaluate((e) => getComputedStyle(e).textDecorationLine))
			.toBe('underline');
	});

	test('filtering is written to the URL, filters every table, and comes back on reload', async ({
		page
	}) => {
		await openDataset(page);
		await filterButton(page, 'Closed').click();
		await expect(filterButton(page, 'Closed')).toHaveAttribute('aria-pressed', 'true');
		await expect(page).toHaveURL(/[?&]openness=closed(&|$)/);
		await expect(page.getByRole('cell', { name: 'open source', exact: true })).toHaveCount(0);

		await filterButton(page, 'Open').click();
		await expect(page).toHaveURL(/[?&]openness=open(,|%2C)closed(&|$)/);

		await page.reload();
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{ timeout: 30_000 }
		);
		await expect(filterButton(page, 'Closed')).toHaveAttribute('aria-pressed', 'true');
		await expect(filterButton(page, 'Open')).toHaveAttribute('aria-pressed', 'true');
		await expect(filterButton(page, 'Open-ish')).toHaveAttribute('aria-pressed', 'false');

		// Clearing every filter drops the param.
		await filterButton(page, 'Closed').click();
		await filterButton(page, 'Open').click();
		await expect(page).not.toHaveURL(/[?&]openness=/);
	});

	test('a junk openness filter keeps the buckets it names correctly', async ({ page }) => {
		await openDataset(page, '?openness=closed,nope');
		await expect(filterButton(page, 'Closed')).toHaveAttribute('aria-pressed', 'true');
		await expect(filterButton(page, 'Open')).toHaveAttribute('aria-pressed', 'false');
	});

	test('a filter that leaves a category empty still shows its row and says so', async ({
		page
	}) => {
		await openDataset(page, '?openness=closed');
		const empty = page.getByText('No products match this filter');
		await expect(empty.first()).toBeVisible();
		// The emptied category keeps its row on the shared grid.
		const row = page
			.getByTestId('category')
			.filter({ has: page.getByText('No products match this filter') })
			.first()
			.getByTestId('category-label');
		const [rowX, anyX] = await Promise.all([
			row.evaluate((e) => Math.round(e.getBoundingClientRect().left)),
			page
				.locator('[data-testid="category-label"]')
				.first()
				.evaluate((e) => Math.round(e.getBoundingClientRect().left))
		]);
		expect(rowX).toBe(anyX);
	});

	test('a header click sorts every table, flips on a second click, and survives a reload and Back via the URL', async ({
		page
	}) => {
		await openDataset(page);
		const first = page.getByTestId('category').first();
		const productHeader = page
			.locator('thead')
			.first()
			.getByRole('button', { name: /^Product/ });
		// The default sort is by overall score, highest first.
		await expect(
			page
				.locator('thead')
				.first()
				.getByRole('button', { name: /^Overall Score/ })
		).toContainText('↑');

		// Every table's product names, top to bottom. The table orders names its own way ("Qwen3"
		// before "Qwen 3.8", digits last), so each order is checked against its own reversal.
		// One evaluate for every table: a locator call per table took ~2.5s a round against a preview
		// (under 0.3s this way), enough to push this test past its 90s timeout on a shared CI runner.
		const allNames = () =>
			page.evaluate(() =>
				[...document.querySelectorAll('[data-testid="category"]')]
					.filter((c) => c.querySelector('table'))
					.map((c) =>
						[...c.querySelectorAll('[data-testid="product-name"]')].map(
							(e) => e.textContent?.trim() ?? ''
						)
					)
			);
		const byScore = await allNames();

		await productHeader.click();
		await expect(page).toHaveURL(/[?&]sort=product&dir=asc/);
		await expect(productHeader).toContainText('↓');
		const asc = await allNames();
		expect(asc, 'sorting by product changed no table').not.toEqual(byScore);

		await productHeader.click();
		await expect(page).toHaveURL(/[?&]sort=product&dir=desc/);
		await expect(productHeader).toContainText('↑');
		expect(await allNames(), 'a table did not flip').toEqual(asc.map((n) => [...n].reverse()));

		await page.reload();
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{ timeout: 30_000 }
		);
		expect(await productNames(first)).toEqual([...asc[0]].reverse());

		// Leaving for another page and coming Back restores the sort, not just the address bar.
		await productHeader.click();
		await expect(page).toHaveURL(/[?&]sort=product&dir=asc/);
		await page
			.getByRole('navigation', { name: 'Map views' })
			.getByRole('link', { name: 'Open source Gap Map' })
			.click();
		// Switching views waits on the other view's load data, which can take over 5s on a preview.
		await expect(page).toHaveURL(/\/map\/gap-map$/, { timeout: 20_000 });
		await page.goBack();
		await expect(page).toHaveURL(/[?&]sort=product&dir=asc/, { timeout: 20_000 });
		await expect(productHeader).toContainText('↓', { timeout: 20_000 });
		expect(await productNames(first)).toEqual(asc[0]);
	});

	test('a product link clears a filter that would hide the product, then highlights its row in view', async ({
		page
	}) => {
		await openDataset(page);
		const closedRow = page
			.locator('tr[data-product-id]')
			.filter({ has: page.getByRole('cell', { name: 'closed', exact: true }) })
			.first();
		const id = await closedRow.getAttribute('data-product-id');

		await openDataset(page, `?openness=open&product=${encodeURIComponent(id!)}`);
		await expect(filterButton(page, 'Open')).toHaveAttribute('aria-pressed', 'false');
		await expect(page).not.toHaveURL(/[?&]openness=/);
		const row = page.locator(`tr[data-highlight][data-product-id="${id}"]`);
		await expect(row).toBeInViewport();
	});

	test('Expand all after a deep link reopens the layer without jumping back to the linked category', async ({
		page
	}) => {
		await openDataset(page);
		const id = await page
			.locator('#layer-product_ux [data-testid="category"]')
			.nth(1)
			.getAttribute('id');
		await openDataset(page, `?category=${encodeURIComponent(id!)}`);
		await expect(page.locator(`[id="${id}"]`)).toBeInViewport();

		const layer = page.locator('#layer-product_ux');
		await layer.getByRole('button', { name: 'Collapse all' }).click();
		// The visitor clicks Expand all where it is, mid-screen; the linked category's row then sits
		// below the first category's reopened table, off screen.
		const expandAll = layer.getByRole('button', { name: 'Expand all' });
		await expandAll.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
		// Record every scroll from the click on. A jump would be a smooth scroll a few hundred
		// milliseconds long, so the record covers a full second.
		await page.evaluate(() => {
			const w = window as unknown as { scrolls: number[]; clickedAt: number };
			w.scrolls = [];
			w.clickedAt = performance.now();
			// eslint-disable-next-line svelte/no-add-event-listener -- page context, not a component
			addEventListener('scroll', () => w.scrolls.push(Math.round(scrollY)), { passive: true });
		});
		const before = await page.evaluate(() => Math.round(window.scrollY));
		await expandAll.click();
		await expect(layer.locator('[aria-expanded="false"]')).toHaveCount(0);
		await page.waitForFunction(
			() => performance.now() - (window as unknown as { clickedAt: number }).clickedAt > 1_000
		);
		const scrolls = await page.evaluate(() => (window as unknown as { scrolls: number[] }).scrolls);
		expect(
			scrolls.filter((y) => Math.abs(y - before) > 1),
			'the page scrolled after Expand all'
		).toEqual([]);
		await expect(page.locator(`[id="${id}"] > button`)).not.toBeInViewport();
	});

	test('a category link opens that category alone, in view, with every other category collapsed', async ({
		page
	}) => {
		await openDataset(page);
		const id = await page
			.locator('#layer-model_components [data-testid="category"]')
			.nth(2)
			.getAttribute('id');
		await openDataset(page, `?layer=model_components&category=${encodeURIComponent(id!)}`);
		const open = page.locator('[data-testid="category"] > button[aria-expanded="true"]');
		await expect(open).toHaveCount(1);
		await expect(page.locator(`[id="${id}"] > button`)).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator(`[id="${id}"] > button`)).toBeInViewport();
	});

	test('choosing a search result reveals a product hidden by the filter and by a collapsed category, and highlights it in view', async ({
		page
	}) => {
		await openDataset(page);
		// An open(ish) product in the last layer, so the jump has a long way to go.
		const target = page
			.locator('#layer-infrastructure tr[data-product-id]:not([data-bucket="closed"])')
			.last();
		const name = (await target.locator('[data-testid="product-name"]').textContent())!.trim();

		await openDataset(page, '?openness=closed');
		const layer = page.locator('#layer-infrastructure');
		await layer.getByRole('button', { name: 'Collapse all' }).click();
		await expect(layer.locator('[aria-expanded="true"]')).toHaveCount(0);
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

		const box = page.getByRole('combobox');
		await expect(box).toHaveAttribute('placeholder', 'Find in the table...');
		await box.fill(name);
		await page
			.getByRole('option')
			.filter({ has: page.getByText(name, { exact: true }) })
			.first()
			.click();

		await expect(filterButton(page, 'Closed')).toHaveAttribute('aria-pressed', 'false');
		await expect(page).not.toHaveURL(/[?&]openness=/);
		const row = page.locator('tr[data-highlight="true"]');
		await expect(row).toHaveCount(1);
		await expect(row.locator('[data-testid="product-name"]')).toHaveText(name);
		await expect(row).toBeInViewport();
	});

	test('hovering a stage pill and a gap diamond each shows its explanation', async ({ page }) => {
		await openDataset(page);
		const stage = page.locator('#layer-product_ux [data-testid="category-stage"]').first();
		const stageName = (await stage.textContent())!.replace(/^.*Maturity:\s*/s, '').trim();
		await hoverSettled(stage.getByRole('img', { name: /Maturity stage/ }));
		await expect(page.getByRole('tooltip')).toContainText(`Maturity: ${stageName}`);

		const gap = page
			.locator('#layer-product_ux [data-testid="category-gaps"]')
			.getByRole('img', { name: / gap$/ })
			.first();
		const label = await gap.getAttribute('aria-label');
		await hoverSettled(gap);
		await expect(page.getByRole('tooltip')).toContainText(label!);
	});

	test('there are no rounded buttons, inputs or chips on the page', async ({ page }) => {
		await openDataset(page);
		const rounded = await page.locator('main button, main input').evaluateAll((els) =>
			els
				.filter((e) => !e.closest('[data-round-ok]'))
				.filter((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) > 0)
				.map((e) => e.outerHTML.slice(0, 80))
		);
		expect(rounded).toEqual([]);
	});

	test('every form control has a programmatic label; the search box is named "Find in the table"', async ({
		page
	}) => {
		await openDataset(page);
		await expect(page.getByRole('combobox', { name: 'Find in the table' })).toBeVisible();
		// WAVE's "Missing form label": a placeholder is not a label, so each control needs a
		// <label>, aria-labelledby, aria-label or a title.
		const unlabelled = await page.locator('input, select, textarea').evaluateAll((els) =>
			els
				.filter(
					(e) =>
						!['image', 'submit', 'reset', 'button', 'hidden'].includes(
							e.getAttribute('type')?.toLowerCase() ?? ''
						)
				)
				.filter(
					(e) =>
						!(
							(e as HTMLInputElement).labels?.length ||
							e.getAttribute('aria-labelledby') ||
							e.getAttribute('aria-label') ||
							(e as HTMLElement).title
						)
				)
				.map((e) => e.outerHTML.slice(0, 120))
		);
		expect(unlabelled).toEqual([]);
	});
});

/**
 * Where the stuck layer bar sits against the site navigation's bottom edge: its own bottom, the
 * top of its tab strip and the bottom of its openness filter.
 */
async function stuckBar(page: Page) {
	return page.getByTestId('layer-bar').evaluate((bar) => {
		const probe = document.createElement('div');
		probe.style.height = 'var(--nav-bar-offset)';
		document.body.append(probe);
		const navBottom = probe.getBoundingClientRect().height;
		probe.remove();
		const filter = bar.querySelector('[role="group"][aria-label="Filter by openness"]')!;
		return {
			navBottom,
			stuckHeight: Math.round(bar.getBoundingClientRect().bottom - navBottom),
			tabsTop: bar.querySelector('nav[aria-label="Layers"]')!.getBoundingClientRect().top,
			filterBottom: filter.getBoundingClientRect().bottom
		};
	});
}

/** Scrolls to the middle of the model components layer's first table. */
async function scrollIntoModelComponents(page: Page) {
	await page
		.locator('#layer-model_components table')
		.first()
		.evaluate((el) =>
			window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2)
		);
}

// Below a 1280px window the bar wraps: the filter and legend take the rows above the tabs, and
// once the bar sticks only the tabs row stays on screen, at the gap map bar's 64px. At 1100px the
// filter, legend button and tabs would fit on one line; the tabs still take their own row.
for (const width of [1024, 1100]) {
	test.describe(`dataset layout, ${width}px wide`, { tag: '@G1' }, () => {
		test.use({ viewport: { width, height: 800 } });

		test('once scrolled, only the tabs row of the wrapped bar stays stuck, with the table header right under it', async ({
			page
		}) => {
			await openDataset(page);
			const bar = page.getByTestId('layer-bar');
			expect((await bar.boundingBox())!.height, 'the bar did not wrap').toBeGreaterThan(100);
			await scrollIntoModelComponents(page);
			await expect.poll(async () => (await stuckBar(page)).stuckHeight).toBe(64);
			const at = await stuckBar(page);
			expect(at.tabsTop, 'the tabs went under the navigation').toBeGreaterThanOrEqual(at.navBottom);
			expect(at.filterBottom, 'the filter is still on screen').toBeLessThanOrEqual(at.navBottom);
			const th = page.locator('#layer-model_components thead th').first();
			await expect
				.poll(async () => (await th.boundingBox())?.y)
				.toBeCloseTo(at.navBottom + at.stuckHeight, 0);
		});

		test('tabbing from the stuck tabs into the filter brings the whole bar back into view', async ({
			page
		}) => {
			await openDataset(page);
			await scrollIntoModelComponents(page);
			await expect.poll(async () => (await stuckBar(page)).stuckHeight).toBe(64);
			await page.getByRole('button', { name: 'About the layers' }).focus();
			await page.keyboard.press('Tab');
			const open = filterButton(page, 'Open');
			await expect(open).toBeFocused();
			const navBottom = (await stuckBar(page)).navBottom;
			await expect
				.poll(async () => (await open.boundingBox())!.y, {
					message: 'the focused filter button is under the navigation'
				})
				.toBeGreaterThanOrEqual(navBottom);
		});
	});
}

// At a 1332px window the bar is 1240px: tabs, filter, short legend and button need 1242px there,
// so the legend waits rather than clip the Infrastructure tab.
test.describe('dataset layout, 1332px wide', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1332, height: 800 } });

	test('every layer tab is shown whole beside the filter and legend', async ({ page }) => {
		await openDataset(page);
		const bar = page.getByTestId('layer-bar');
		expect(Math.round((await bar.boundingBox())!.width)).toBe(1240);
		const clipped = await page.getByRole('navigation', { name: 'Layers' }).evaluate((nav) => {
			const right = nav.getBoundingClientRect().right;
			return [...nav.querySelectorAll('a')]
				.filter((a) => a.getBoundingClientRect().right > right + 0.5)
				.map((a) => a.textContent?.trim());
		});
		expect(clipped).toEqual([]);
		await expect(bar.getByRole('button', { name: 'How to read the map' })).toBeVisible();
	});
});

test.describe('dataset layout, phone', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	test('the bar shows the filter and legend above the tabs, and once scrolled only the 64px tabs row stays stuck', async ({
		page
	}) => {
		await openDataset(page);
		const bar = page.getByTestId('layer-bar');
		expect((await bar.boundingBox())!.height, 'the bar did not wrap').toBeGreaterThan(100);
		const before = await stuckBar(page);
		expect(before.filterBottom, 'the filter is not above the tabs').toBeLessThanOrEqual(
			before.tabsTop
		);
		await scrollIntoModelComponents(page);
		await expect.poll(async () => (await stuckBar(page)).stuckHeight).toBe(64);
		const at = await stuckBar(page);
		expect(at.tabsTop, 'the tabs went under the navigation').toBeGreaterThanOrEqual(at.navBottom);
		expect(at.filterBottom, 'the filter is still on screen').toBeLessThanOrEqual(at.navBottom);
	});

	test('a tapped tab lands its layer right under the stuck tabs', async ({ page }) => {
		await openDataset(page);
		const tab = page
			.getByRole('navigation', { name: 'Layers' })
			.getByRole('link', { name: /model components/i });
		await tab.tap();
		await expect(tab).toHaveAttribute('aria-current', 'location');
		await expect(page.locator('html')).not.toHaveClass(/jumping/, { timeout: 3000 });
		const at = await stuckBar(page);
		const top = await page
			.locator('#layer-model_components')
			.evaluate((el) => el.getBoundingClientRect().top);
		expect(Math.abs(top - (at.navBottom + at.stuckHeight))).toBeLessThan(4);
	});

	// The shape is a flex item beside its label, so in a narrow cell it must not shrink.
	test("every product's openness shape stays square", async ({ page }) => {
		await openDataset(page);
		const shapes = await page
			.locator(
				'tr[data-product-id]:not([data-bucket="closed"]) td:nth-child(3) > div > :first-child'
			)
			.evaluateAll((els) =>
				els.map((e) => {
					const r = e.getBoundingClientRect();
					return {
						product: e.closest('tr')!.querySelector('[data-testid="product-name"]')!.textContent,
						width: Math.round(r.width),
						height: Math.round(r.height)
					};
				})
			);
		expect(shapes.length, 'no open or open-ish product is listed').toBeGreaterThan(0);
		expect(shapes.filter((s) => s.width !== s.height)).toEqual([]);
	});

	// A cell breaks inside a word only when the word is wider than its column, so the
	// product and openness columns are as wide as their longest word.
	test('a one-word product name keeps to one line, and an openness type to two', async ({
		page
	}) => {
		await openDataset(page);
		const lineCount = (els: Element[]) =>
			els.map((e) => {
				const range = document.createRange();
				range.selectNodeContents(e);
				const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
				return { text: e.textContent!.trim(), lines: tops.size };
			});
		const names = await page.locator('[data-testid="product-name"]').evaluateAll(lineCount);
		const oneWord = names.filter((n) => !/[\s-]/.test(n.text));
		expect(oneWord.length, 'no product has a one-word name').toBeGreaterThan(0);
		expect(oneWord.filter((n) => n.lines > 1)).toEqual([]);

		const types = await page
			.locator('tr[data-product-id] td:nth-child(3) > div > span')
			.evaluateAll(lineCount);
		expect(types.map((t) => t.text)).toContain('source available');
		expect(types.filter((t) => t.lines > 2)).toEqual([]);
	});

	// A header sticky inside the sideways-scrolling table container takes its top offset
	// within the table, so below md it is not sticky.
	test("a category's column headers start right at the top of its table", async ({ page }) => {
		await openDataset(page);
		const gaps = await page
			.locator('[data-testid="category"] table')
			.evaluateAll((tables) =>
				tables.map((t) =>
					Math.round(
						t.querySelector('thead th')!.getBoundingClientRect().top - t.getBoundingClientRect().top
					)
				)
			);
		expect(gaps.length).toBeGreaterThan(0);
		expect([...new Set(gaps)]).toEqual([0]);
	});

	// A header sticking to the sideways-scrolling table box, not the page, lands over the rows.
	test('the table header sits above the first row, not over it', async ({ page }) => {
		await openDataset(page);
		const table = page.locator('#layer-model_components table').first();
		await table.scrollIntoViewIfNeeded();
		const [head, row] = await table.evaluate((el) =>
			[el.querySelector('thead th')!, el.querySelector('tbody tr')!].map(
				(e) => e.getBoundingClientRect().toJSON() as DOMRect
			)
		);
		expect(head.bottom, 'the header overlaps the first row').toBeLessThanOrEqual(row.top + 1);
	});

	test('the page never scrolls sideways', async ({ page }) => {
		await openDataset(page);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, 'the page is wider than the phone').toBeLessThanOrEqual(0);
	});
});

// Below lg a category's stage and counts sit under its name and description, across the
// full width below md and in line with the name from md; from lg they take their columns on the
// shared grid, on the name's row.
for (const [width, layout] of [
	[425, 'full width'],
	[768, 'under the name'],
	[1000, 'under the name'],
	[1024, 'on the row']
] as const) {
	test.describe(`dataset category header, ${width}px wide`, { tag: '@G1' }, () => {
		test.use({ viewport: { width, height: 800 } });

		test(`the stage and counts sit ${layout === 'on the row' ? "on the category name's row" : `below the category name, ${layout}`}`, async ({
			page
		}) => {
			await openDataset(page);
			const rows = await page.getByTestId('category').evaluateAll((els) =>
				els.map((el) => {
					const box = (id: string) =>
						el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
					const label = el.querySelector('[data-testid="category-label"]')!;
					const counts = el
						.querySelector('[data-testid="category-counts"] span')!
						.getBoundingClientRect();
					return {
						label: label.textContent!.trim(),
						labelTop: Math.round(box('category-label').top),
						labelLeft: Math.round(box('category-label').left),
						textBottom: Math.round(label.parentElement!.getBoundingClientRect().bottom),
						stageTop: Math.round(box('category-stage').top),
						stageLeft: Math.round(box('category-stage').left),
						countsTop: Math.round(counts.top),
						countsLeft: Math.round(counts.left)
					};
				})
			);
			expect(rows.length).toBeGreaterThan(1);
			for (const r of rows) {
				if (layout === 'on the row') {
					expect(r.stageTop, `${r.label}: the stage left the name's row`).toBe(r.labelTop);
					expect(r.countsTop, `${r.label}: the counts left the name's row`).toBe(r.labelTop);
					continue;
				}
				expect(r.stageTop, `${r.label}: the stage is beside the name`).toBeGreaterThanOrEqual(
					r.textBottom
				);
				expect(r.countsTop, `${r.label}: the counts are above the stage`).toBeGreaterThan(
					r.stageTop
				);
				if (layout === 'full width') {
					expect(r.stageLeft, `${r.label}: the stage is indented`).toBeLessThan(r.labelLeft);
					expect(r.countsLeft, `${r.label}: the counts are indented`).toBe(r.stageLeft);
				} else {
					expect(r.stageLeft, `${r.label}: the stage is out of line with the name`).toBe(
						r.labelLeft
					);
					expect(r.countsLeft, `${r.label}: the counts are out of line with the name`).toBe(
						r.labelLeft
					);
				}
			}
		});
	});
}
