// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';

// G1, the gap map's layout (CUR-732). Each test is one
// "Done when" line from that spec, asserted on the rendered page rather than on the markup that
// produces it. Counts are asserted by shape, not value: they change every time the catalog is
// rescored, and a pinned number would go red on the map working as intended.

const GAP_MAP = '/map/gap-map';

/**
 * Hover without scrolling during the hover: tooltips hide on scroll, and Playwright's own
 * scroll-into-view would fire that scroll after the pointer arrives. Centre the element first,
 * let the scroll's events flush, then hover.
 */
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

async function openMap(page: Page) {
	const res = await page.goto(GAP_MAP, { waitUntil: 'domcontentloaded' });
	// An error page has a heading too, and never hydrates, so without this every test below waits
	// out the hydration marker twice and one 500 fills a whole shard's time limit.
	expect(res?.status(), `${GAP_MAP} answered ${res?.status()}`).toBe(200);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
	// The server-rendered page is visible before it is interactive, and a click that lands before
	// hydration does nothing. The layer bar marks a tab active only from client code, so a marked
	// tab means the page has hydrated.
	await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(1, {
		timeout: 30_000
	});
}

/**
 * Every product the full dataset lists, read from its server-rendered page so a search test is not
 * pinned to a catalog value. `bucket` is the openness bucket (open, open-ish or closed);
 * `org` is set when the org has a page.
 */
async function datasetRows(page: Page) {
	return page.evaluate(async () => {
		const html = await (await fetch('/map/dataset')).text();
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return [...doc.querySelectorAll('tr[data-product-id]')].map((r) => ({
			name: r.querySelector('[data-testid="product-name"]')?.textContent?.trim() ?? '',
			bucket: r.getAttribute('data-bucket') ?? '',
			org: r.querySelector('a[href^="/org/"]')?.textContent?.trim() ?? null
		}));
	});
}

test.describe('gap map layout, desktop', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the page has no grid background, no black and no pale-grey (#b7cacc) text', async ({
		page
	}) => {
		await openMap(page);
		const offenders = await page.locator('#map').evaluate((root) => {
			const found: string[] = [];
			for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
				const style = getComputedStyle(el);
				if (style.backgroundImage.includes('linear-gradient')) found.push(`grid: ${el.tagName}`);
				const hasText = [...el.childNodes].some(
					(n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
				);
				if (hasText && ['rgb(0, 0, 0)', 'rgb(183, 202, 204)'].includes(style.color))
					found.push(`${style.color}: "${el.textContent?.trim().slice(0, 40)}"`);
				for (const prop of ['borderTopColor', 'outlineColor', 'backgroundColor'] as const)
					if (
						style[prop] === 'rgb(0, 0, 0)' &&
						style[prop.replace('Color', 'Style') as never] !== 'none'
					)
						found.push(`black ${prop}: ${el.tagName}.${el.className}`.slice(0, 120));
			}
			return found;
		});
		expect(offenders, 'the page still draws a grid, black, or #b7cacc text').toEqual([]);
	});

	test('the header states total, assessed and open(ish) products and the gaps to fill, in that order', async ({
		page
	}) => {
		await openMap(page);
		const figures = page.locator('#map header dl > div');
		await expect(figures).toHaveCount(4);
		const read = await figures.evaluateAll((els) =>
			els.map((el) => ({
				label: el.querySelector('dt')?.textContent?.replace(/\s*›$/, '').trim(),
				value: el.querySelector('dd')?.textContent?.trim()
			}))
		);
		expect(read.map((f) => f.label)).toEqual([
			'Total products mapped',
			'Assessed products',
			'Open(ish) products',
			'Gaps to fill'
		]);
		for (const f of read) expect(f.value, `${f.label} is not a number`).toMatch(/^\d[\d,]*$/);
	});

	test('each layer has a serif title with its category and gap counts, and each row says what it draws', async ({
		page
	}) => {
		await openMap(page);
		const titles = page.locator('#map section > div > h2');
		expect(await titles.count(), 'no layer titles').toBeGreaterThan(0);
		for (const title of await titles.all()) {
			expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Noto Serif/i);
			await expect(title.locator('xpath=following-sibling::p')).toHaveText(
				/^\d+ product categor(y|ies) · \d+ gaps? found$/
			);
		}
		const captions = page.getByTestId('row-caption');
		expect(
			await captions.count(),
			'no row states how many open(ish) products it draws'
		).toBeGreaterThan(10);
		for (const text of await captions.allInnerTexts())
			expect(text).toMatch(
				/^\d+ open\(ish\) products • (none leading or strong|\d+ leading(, \d+ strong)?|\d+ strong)$/
			);
	});

	test('a hovered row turns pale grey and underlines its name', async ({ page }) => {
		await openMap(page);
		const row = page
			.getByRole('button')
			.filter({ hasText: /\d+ open\(ish\) products/ })
			.first();
		await row.hover({ position: { x: 20, y: 10 } });
		await expect(row).toHaveCSS('background-color', 'rgb(243, 245, 245)');
		const name = row.locator('div.uppercase').first();
		await expect(name).toHaveCSS('text-decoration-line', 'underline');
	});

	test('every row shows its maturity stage as n/5, and the header columns line up with the row cells', async ({
		page
	}) => {
		await openMap(page);
		const rows = page.getByRole('button').filter({ hasText: /\d+ open\(ish\) products/ });
		const n = await rows.count();
		for (let i = 0; i < n; i++)
			await expect(
				rows.nth(i).getByRole('img', { name: /^Maturity stage [0-5] of 5$/ })
			).toHaveText(/^[0-5]\/5$/);

		const header = page.getByTestId('layer-column-header').first();
		await expect(header).toHaveText(
			/^maturity\s*gaps found.*category\s*open\(ish\) products\s*ordered by score$/i
		);
		const headerX = await header
			.locator('> span')
			.evaluateAll((els) =>
				els.map((el) =>
					Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
				)
			);
		const rowX = await rows
			.first()
			.locator('> div')
			.evaluateAll((els) =>
				els.map((el) =>
					Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
				)
			);
		expect(rowX, 'a header column does not start where its row cells start').toEqual(headerX);
	});

	test('the column headers are set in Plus Jakarta 14px semibold dark blue, sentence case, "ordered by score" in grey', async ({
		page
	}) => {
		await openMap(page);
		const header = page.getByTestId('layer-column-header').first();
		const button = header.getByRole('button', { name: /^maturity/i });
		expect(await button.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Plus Jakarta/i);
		await expect(button).toHaveCSS('font-size', '14px');
		await expect(button).toHaveCSS('font-weight', '600');
		await expect(button).toHaveCSS('text-transform', 'none');
		await expect(button).toHaveCSS('color', 'rgb(20, 46, 62)');
		const note = header.getByText('ordered by score');
		const [noteColor, labelColor] = await Promise.all([
			note.evaluate((el) => getComputedStyle(el).color),
			button.evaluate((el) => getComputedStyle(el).color)
		]);
		expect(noteColor, '"ordered by score" is not set apart from the label').not.toBe(labelColor);
	});

	test('the map opens sorted by gaps found, most first, with ↑ on that column only', async ({
		page
	}) => {
		await openMap(page);
		const header = page.getByTestId('layer-column-header').first();
		await expect(header.getByRole('button', { name: /gaps found/i })).toContainText('↑');
		for (const other of [/^maturity/i, /^category/i, /^open\(ish\) products/i])
			await expect(header.getByRole('button', { name: other })).not.toContainText(/[↑↓]/);
		for (const layer of ['product_ux', 'model_components', 'infrastructure']) {
			const counts = await page
				.locator(`#layer-${layer} [data-testid="gap-count"]`)
				.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-count'))));
			expect(counts.length, `${layer} has no rows`).toBeGreaterThan(1);
			expect(counts, `${layer} is not most gaps first`).toEqual([...counts].sort((a, b) => b - a));
		}
	});

	test('sorting by open(ish) products reorders every layer, flips on a second click, and survives a reload via the URL', async ({
		page
	}) => {
		await openMap(page);
		const openCounts = (layer: string) =>
			page
				.locator(`#layer-${layer} [data-testid="row-caption"]`)
				.evaluateAll((els) => els.map((el) => parseInt(el.textContent?.trim() ?? '', 10)));
		const layers = ['product_ux', 'model_components', 'infrastructure'];
		const header = () => page.getByTestId('layer-column-header').first();

		await header()
			.getByRole('button', { name: /open\(ish\) products/i })
			.click();
		await expect(page).toHaveURL(/[?&]sort=open&dir=desc/);
		await expect(header().getByRole('button', { name: /open\(ish\) products/i })).toContainText(
			'↑'
		);
		await page.reload();
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{ timeout: 30_000 }
		);
		for (const layer of layers) {
			const open = await openCounts(layer);
			expect(open.every(Number.isFinite), `${layer}: a caption has no leading count`).toBe(true);
			expect(open, `${layer} is not most open(ish) products first`).toEqual(
				[...open].sort((a, b) => b - a)
			);
		}

		await header()
			.getByRole('button', { name: /open\(ish\) products/i })
			.click();
		await expect(page).toHaveURL(/[?&]sort=open&dir=asc/);
		await expect(header().getByRole('button', { name: /open\(ish\) products/i })).toContainText(
			'↓'
		);
		const asc = await openCounts('product_ux');
		expect(asc).toEqual([...asc].sort((a, b) => a - b));

		// Leaving for another page and coming Back restores the sort, not just the address bar.
		await page
			.getByRole('navigation', { name: 'Map views' })
			.getByRole('link', { name: 'Full dataset' })
			.click();
		// Switching views waits on the other view's load data, which can take over 5s on a preview.
		await expect(page).toHaveURL(/\/map\/dataset$/, { timeout: 20_000 });
		await page.goBack();
		await expect(page).toHaveURL(/[?&]sort=open&dir=asc/, { timeout: 20_000 });
		await expect(header().getByRole('button', { name: /open\(ish\) products/i })).toContainText(
			'↓',
			{ timeout: 20_000 }
		);
		const back = await openCounts('product_ux');
		expect(back).toEqual([...back].sort((a, b) => a - b));

		// Back to the default: the URL drops both params.
		await header()
			.getByRole('button', { name: /gaps found/i })
			.click();
		await expect(page).not.toHaveURL(/[?&](sort|dir)=/);
	});

	test('a junk sort in the URL opens the default view rather than failing', async ({ page }) => {
		const res = await page.goto(`${GAP_MAP}?sort=bogus&dir=sideways`, {
			waitUntil: 'domcontentloaded'
		});
		expect(res?.status()).toBe(200);
		await expect(
			page
				.getByTestId('layer-column-header')
				.first()
				.getByRole('button', { name: /gaps found/i })
		).toContainText('↑', { timeout: 30_000 });
	});

	test("a layer's header row sticks under the layer bar until the next layer's header replaces it", async ({
		page
	}) => {
		await openMap(page);
		const headers = page.getByTestId('layer-column-header');
		// Where a pinned header sits: the stuck layer bar's bottom edge.
		const pinnedAt = async () => {
			const b = await page.getByTestId('layer-bar').boundingBox();
			return b!.y + b!.height;
		};
		const sections = page.locator('#map section[id^="layer-"]');
		// Scroll to the middle of the first layer: its header is pinned, the second's is not yet.
		await sections
			.nth(0)
			.evaluate((el) =>
				window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2)
			);
		await expect
			.poll(async () => (await headers.nth(0).boundingBox())?.y)
			.toBeCloseTo(await pinnedAt(), 0);
		expect((await headers.nth(1).boundingBox())!.y).toBeGreaterThan((await pinnedAt()) + 100);
		// Into the second layer: its header takes the pinned slot and the first has scrolled away.
		await sections
			.nth(1)
			.evaluate((el) =>
				window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2)
			);
		await expect
			.poll(async () => (await headers.nth(1).boundingBox())?.y)
			.toBeCloseTo(await pinnedAt(), 0);
		expect((await headers.nth(0).boundingBox())!.y).toBeLessThan(await pinnedAt());
	});

	test('the layer bar stays under the navigation, follows the layer in view, and its tabs jump to their layer', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		const tabs = bar.getByRole('navigation', { name: 'Layers' }).getByRole('link');
		expect(await tabs.count(), 'the bar has no layer tabs').toBeGreaterThan(1);
		await expect(bar).toHaveCSS('box-shadow', 'none');
		const navBottom = await page
			.locator('header')
			.first()
			.evaluate((el) => el.getBoundingClientRect().bottom);

		// Halfway down the chart: the bar's sticky range ends with the chart, so a fixed distance
		// would land past it whenever the chart gets shorter.
		const halfway = await bar.evaluate((el) => {
			const chart = el.parentElement!.getBoundingClientRect();
			return chart.top + chart.height / 2;
		});
		await page.mouse.wheel(0, halfway);
		// Within 2px: the site header's 1px bottom border overlaps the bar's top edge.
		await expect
			.poll(async () => Math.abs((await bar.boundingBox())!.y - navBottom))
			.toBeLessThan(2);

		// Scrolling from one layer into the next moves the highlight with it.
		const sections = page.locator('#map section[id^="layer-"]');
		for (const i of [0, 1]) {
			await sections.nth(i).evaluate((el) =>
				window.scrollTo({
					top: el.getBoundingClientRect().top + window.scrollY + 200,
					behavior: 'instant'
				})
			);
			await expect(tabs.nth(i)).toHaveAttribute('aria-current', 'location');
			await expect(bar.locator('[aria-current="location"]')).toHaveCount(1);
		}

		// A tab puts its layer's title just below the bar, not under it.
		const last = (await tabs.count()) - 1;
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
		await tabs.nth(last).click();
		await expect(tabs.nth(last)).toHaveAttribute('aria-current', 'location');
		// The clicked tab is active from the click on, so the jump's end is read from the page.
		await expect(page).toHaveURL(new RegExp(`#${await sections.nth(last).getAttribute('id')}$`));
		const title = sections.nth(last).getByRole('heading', { level: 2 });
		await expect
			.poll(
				async () => {
					const [t, b] = await Promise.all([title.boundingBox(), bar.boundingBox()]);
					return t && b ? t.y - (b.y + b.height) : -1;
				},
				{ message: "the layer's title is hidden under the sticky bar, or far below it" }
			)
			.toBeGreaterThanOrEqual(0);
		const gap = await title.evaluate(
			(el, barEl) => el.getBoundingClientRect().top - barEl!.getBoundingClientRect().bottom,
			await bar.elementHandle()
		);
		expect(gap).toBeLessThan(120);
	});

	test('the layer bar is white with the tabs on a pale grey box, and a tab that is not the current layer darkens on hover', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		await expect(bar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		const tabsBox = bar.getByRole('navigation', { name: 'Layers' }).locator('..');
		await expect(tabsBox).toHaveCSS('background-color', 'rgb(243, 245, 245)');
		const tab = bar.locator('nav a:not([aria-current])').first();
		await tab.hover();
		await expect(tab).toHaveCSS('background-color', 'rgb(230, 230, 230)');
	});

	test('the layer tabs read Product / UX, Model components, Infrastructure in that order', async ({
		page
	}) => {
		await openMap(page);
		await expect(
			page.getByTestId('layer-bar').getByRole('navigation', { name: 'Layers' }).getByRole('link')
		).toHaveText(['Product / UX', 'Model components', 'Infrastructure'], { useInnerText: true });
	});

	test('the ? button opens the layers dialog, the page behind does not scroll, Esc closes it', async ({
		page
	}) => {
		await openMap(page);
		await page.getByTestId('layer-bar').getByRole('button', { name: 'About the layers' }).click();
		const dialog = page.getByRole('dialog', { name: 'The 3 layers of the AI stack' });
		await expect(dialog).toBeVisible();
		for (const title of ['Product / UX', 'Model Components', 'Infrastructure'])
			await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
		const diagram = dialog.getByRole('img', { name: /three stacked layers/i });
		await expect(diagram).toBeVisible();
		expect(
			await diagram.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
			'the layers diagram did not load'
		).toBe(true);

		// The page behind stays where it is: a wheel outside the dialog's own scroll area.
		const before = await page.evaluate(() => window.scrollY);
		await page.mouse.move(8, 400);
		await page.mouse.wheel(0, 800);
		await expect
			.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow))
			.toBe('hidden');
		expect(await page.evaluate(() => window.scrollY)).toBe(before);

		const pageOverflow = () =>
			page.evaluate(() => getComputedStyle(document.documentElement).overflow);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect.poll(pageOverflow).not.toBe('hidden');

		await page.getByTestId('layer-bar').getByRole('button', { name: 'About the layers' }).click();
		await expect.poll(pageOverflow).toBe('hidden');
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).toBeHidden();
		await expect.poll(pageOverflow).not.toBe('hidden');
	});

	test('a tab jump keeps the clicked tab active the whole way, then lands its section under the bar', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		const tabs = bar.getByRole('navigation', { name: 'Layers' }).getByRole('link');
		const infra = tabs.filter({ hasText: 'Infrastructure' });
		// Record which tab is active on every frame of the jump, from the click until it settles.
		// Also record the column headers' position on every frame of the jump: they are unstuck
		// while it moves, so the headers of the sections it passes never pin and flash by.
		type Recorder = { __active: string[]; __positions: string[]; __stop: boolean };
		await page.evaluate(() => {
			const w = window as unknown as Recorder;
			w.__active = [];
			w.__positions = [];
			w.__stop = false;
			const tick = () => {
				const a = document.querySelector('[data-testid="layer-bar"] [aria-current="location"]');
				w.__active.push(a?.textContent?.trim() ?? '');
				if (document.documentElement.classList.contains('jumping'))
					for (const h of document.querySelectorAll('[data-testid="layer-column-header"]'))
						w.__positions.push(getComputedStyle(h).position);
				if (!w.__stop) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await infra.click();
		await expect(page.locator('html')).toHaveClass(/jumping/);
		await expect(page.locator('html')).not.toHaveClass(/jumping/, { timeout: 5000 });
		const { seen, positions } = await page.evaluate(() => {
			const w = window as unknown as Recorder;
			w.__stop = true;
			return { seen: w.__active, positions: w.__positions };
		});
		expect(positions.length, 'no frame of the jump was recorded').toBeGreaterThan(0);
		expect(new Set(positions), 'a column header stayed sticky during the jump').toEqual(
			new Set(['static'])
		);
		await expect(page.getByTestId('layer-column-header').first()).toHaveCSS('position', 'sticky');
		expect(seen, 'the jump was never recorded').toContain('Infrastructure');
		const afterClick = seen.slice(seen.indexOf('Infrastructure'));
		expect(new Set(afterClick), 'another tab lit up during the jump').toEqual(
			new Set(['Infrastructure'])
		);
		await expect(infra).toHaveAttribute('aria-current', 'location');
		await expect(page).toHaveURL(/#layer-infrastructure$/);

		const [barBottom, top] = await Promise.all([
			bar.evaluate((el) => el.getBoundingClientRect().bottom),
			page.locator('#layer-infrastructure').evaluate((el) => el.getBoundingClientRect().top)
		]);
		expect(Math.abs(top - barBottom), 'the section does not start at the bar').toBeLessThan(4);
	});

	test('the bar carries the legend, and "How to read the map" opens a modal that Esc, ✕ and the backdrop all close', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		await expect(bar.getByTestId('legend-shapes')).toHaveText('Open source Open-ish', {
			useInnerText: true
		});
		await expect(bar.getByTestId('legend-strip')).toHaveText('Product score', {
			useInnerText: true
		});

		const open = bar.getByRole('button', { name: 'How to read the map' });
		const dialog = page.getByRole('dialog', { name: 'How to read the map' });
		await open.click();
		await expect(dialog).toBeVisible();
		// Titled like a layer heading at its phone size: Noto Serif, semibold, 20px.
		const title = dialog.getByRole('heading', { name: 'How to read the map' });
		expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Noto Serif/i);
		await expect(title).toHaveCSS('font-size', '20px');
		await expect(title).toHaveCSS('font-weight', '600');
		for (const line of [
			'Maturity stage:',
			'Fully open products are absent',
			'Mature Open Ecosystem',
			'Openness:',
			'This map only shows the first 2 types.',
			'Product score:',
			'Leading (4.5 or more)',
			'Strong (4.0 to 4.4)',
			'Available (below 4.0)',
			'Gaps:',
			'Capability gap',
			'Adoption gap',
			'Resiliency gap',
			'Openness gap',
			'Disclosure gap'
		])
			await expect(dialog).toContainText(line);
		await expect(dialog.getByRole('link', { name: 'Methodology page' })).toHaveAttribute(
			'href',
			/\/map\/methodology$/
		);
		expect(
			await dialog.evaluate((d) => d.contains(document.activeElement)),
			'focus is not inside the open dialog'
		).toBe(true);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		await open.click();
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).toBeHidden();

		await open.click();
		await page.mouse.click(8, 400); // the backdrop, left of the centred dialog
		await expect(dialog).toBeHidden();
	});

	test('hovering a square shows that one product, inside the viewport, and scrolling hides it (CUR-2214)', async ({
		page
	}) => {
		await openMap(page);
		const row = page.getByRole('button').filter({ hasText: /core ml frameworks/i });
		const square = row.getByRole('img').last();
		const name = await square.getAttribute('aria-label');
		await hoverSettled(square);
		const tip = page.getByRole('tooltip');
		await expect(tip).toBeVisible();
		await expect(tip).toContainText(/core ml frameworks/i);
		await expect(tip).toContainText(name!);
		await expect(tip).toContainText(/^(.*)(Open source|Open-ish)/);
		await expect(tip).toContainText(/(Leading|Strong) · \d\.\d|Available/);
		const box = (await tip.boundingBox())!;
		const vp = page.viewportSize()!;
		expect(box.width).toBeLessThanOrEqual(260);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(
			box.y + box.height,
			'the tooltip runs past the bottom of the window'
		).toBeLessThanOrEqual(vp.height);

		await page.mouse.wheel(0, 200);
		await expect(tip).toBeHidden();
	});

	test('a square near the top opens its tooltip below it, clear of the sticky bar', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		const row = page
			.locator('#map section[id^="layer-"]')
			.nth(1)
			.getByRole('button')
			.filter({ hasText: /\d+ open\(ish\) products/ })
			.first();
		await row.evaluate(
			(el) =>
				new Promise<void>((done) => {
					const bar = document.querySelector('[data-testid="layer-bar"]')!.getBoundingClientRect();
					window.scrollTo({
						top: el.getBoundingClientRect().top + window.scrollY - bar.height - 100,
						behavior: 'instant'
					});
					requestAnimationFrame(() => requestAnimationFrame(() => done()));
				})
		);
		const square = row.getByRole('img').last();
		await square.hover();
		const tip = page.getByRole('tooltip');
		await expect(tip).toBeVisible();
		const [t, sq, b] = await Promise.all([
			tip.boundingBox(),
			square.boundingBox(),
			bar.boundingBox()
		]);
		expect(t!.y, 'the tooltip opened above, under the sticky bar').toBeGreaterThan(sq!.y);
		expect(t!.y).toBeGreaterThan(b!.y + b!.height);
	});

	test('hovering a gap diamond names the gap and says what the category needs', async ({
		page
	}) => {
		await openMap(page);
		const gap = page
			.locator('#map section[id^="layer-"]')
			.first()
			.getByRole('img', { name: / gap$/ })
			.first();
		const label = await gap.getAttribute('aria-label');
		await hoverSettled(gap);
		const tip = page.getByRole('tooltip');
		await expect(tip).toContainText(label!);
		await expect(tip).toContainText(/Needs .+\./);
	});

	test('hovering a stage pill names the maturity stage, as on the dataset', async ({ page }) => {
		await openMap(page);
		const pill = page
			.locator('#map section[id^="layer-"]')
			.first()
			.getByRole('img', { name: /Maturity stage/ })
			.first();
		await hoverSettled(pill);
		await expect(page.getByRole('tooltip')).toContainText(/^Maturity: \S/);
	});

	test('there are no rounded buttons, inputs or chips on the page', async ({ page }) => {
		await openMap(page);
		const rounded = await page.locator('main button, main input').evaluateAll((els) =>
			els
				.filter((e) => !e.closest('[data-round-ok]'))
				.filter((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) > 0)
				.map((e) => e.outerHTML.slice(0, 80))
		);
		expect(rounded).toEqual([]);
	});

	test("every row's stage pill matches the stage its category panel shows", async ({ page }) => {
		await openMap(page);
		const rows = page.getByRole('button').filter({ hasText: /\d+ open\(ish\) products/ });
		const panelStage = page
			.locator('aside')
			.getByRole('img', { name: /^Maturity stage [0-5] of 5$/ });
		const n = await rows.count();
		for (let i = 0; i < n; i++) {
			const row = rows.nth(i);
			const stage = await row
				.getByRole('img', { name: /^Maturity stage [0-5] of 5$/ })
				.getAttribute('aria-label');
			// The row's name, not its middle: a click on a square opens that product instead.
			await row.locator('div.uppercase').first().click();
			await expect(panelStage, `panel stage for row ${i}`).toHaveAttribute('aria-label', stage!);
		}
	});

	test('the category panel names its score column "Product score", and a long product name truncates on its own line with the organisation under it (CUR-2213)', async ({
		page
	}) => {
		await openMap(page);
		await page.locator('#map').getByText('Fine-tuning code', { exact: true }).first().click();
		const panel = page.locator('aside').filter({ hasText: 'Category in the' });
		await expect(panel.getByText(/^Maturity stage$/)).toBeVisible();
		const tables = panel.locator('table');
		expect(await tables.count()).toBeGreaterThan(0);
		for (const table of await tables.all()) {
			await expect(table.locator('thead')).toContainText('Product score');
			for (const row of await table.locator('tbody tr').all()) {
				const [name, org] = await row.locator('td span.truncate').all();
				const score = row.locator('td').last();
				const [n, sc] = await Promise.all([name.boundingBox(), score.boundingBox()]);
				expect(n!.x + n!.width, 'a product name runs under the score').toBeLessThanOrEqual(
					sc!.x + 1
				);
				expect(n!.height, 'a product name wraps onto a second line').toBeLessThan(24);
				expect(await name.getAttribute('title')).toBe(await name.textContent());
				if (org) expect((await org.boundingBox())!.y).toBeGreaterThanOrEqual(n!.y + n!.height - 1);
			}
		}
	});

	test('the category panel slides open at its full width rather than re-wrapping as it grows', async ({
		page
	}) => {
		await openMap(page);
		// The category panel is the aside with no rail button; its last child holds the content.
		// Sample that content's width on every frame from the click until the open animation ends.
		const sampling = page.evaluate(
			() =>
				new Promise<number[]>((done) => {
					const content = document.querySelector('aside:not(:has(> button))')!.lastElementChild!;
					const widths: number[] = [];
					const start = performance.now();
					const tick = () => {
						widths.push(Math.round(content.getBoundingClientRect().width));
						if (performance.now() - start < 600) requestAnimationFrame(tick);
						else done(widths);
					};
					tick();
				})
		);
		await page.locator('#map').getByText('Fine-tuning code', { exact: true }).first().click();
		const widths = await sampling;
		const open = widths.at(-1)!;
		expect(open, 'the panel did not open').toBeGreaterThan(300);
		expect(
			widths.filter((w) => w !== open),
			'the content changed width while the panel opened'
		).toEqual([]);
	});

	test('the category panel ends with "Challenge it", opening the report-a-bug form in a new tab with the category', async ({
		page
	}) => {
		await openMap(page);
		await page.locator('#map').getByText('Fine-tuning code', { exact: true }).first().click();
		const link = page.getByRole('link', { name: 'Think a score is wrong? Challenge it' });
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute('target', '_blank');
		const url = new URL((await link.getAttribute('href'))!);
		expect(url.host).toBe('tally.so');
		expect(url.searchParams.get('cta'), 'the form does not open on "Report a bug"').toBe(
			'report-bug'
		);
		expect(url.searchParams.get('category'), 'the report carries no category').toBeTruthy();
		// It closes the panel: nothing in the panel comes after it.
		expect(await link.evaluate((el) => el.nextElementSibling)).toBeNull();
	});

	test('search finds an open(ish) product and opens its page; Back returns to the map', async ({
		page
	}) => {
		await openMap(page);
		const box = page.getByRole('combobox');
		await expect(box).toHaveAttribute('placeholder', 'Search open(ish) products or organizations');
		const name = (await datasetRows(page)).find((r) => r.bucket !== 'closed')?.name;
		expect(name, 'no open(ish) product in the dataset').toBeTruthy();
		await box.fill(name!);
		await page
			.getByRole('option')
			.filter({ has: page.getByText(name!, { exact: true }) })
			.first()
			.click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });
		await page.goBack();
		await expect(page).toHaveURL(/\/map\/gap-map/);
	});

	test('search finds an organization, marked Org, and opens its page', async ({ page }) => {
		await openMap(page);
		// An org behind an open product, read from the dataset so the test is not pinned to a catalog
		// value.
		const org = (await datasetRows(page)).find((r) => r.bucket !== 'closed' && r.org)?.org;
		expect(org, 'no open product with an organization page in the dataset').toBeTruthy();
		await page.getByRole('combobox').fill(org!);
		const option = page
			.getByRole('option')
			.filter({ has: page.getByText('Org', { exact: true }) })
			.filter({ hasText: org! });
		await option.first().click();
		await expect(page).toHaveURL(/\/org\//, { timeout: 20_000 });
	});

	test('search does not offer closed products', async ({ page }) => {
		await openMap(page);
		// A closed product's name that no open(ish) product shares.
		const rows = await datasetRows(page);
		const openNames = new Set(rows.filter((r) => r.bucket !== 'closed').map((r) => r.name));
		const closed = rows.find((r) => r.bucket === 'closed' && !openNames.has(r.name))?.name;
		expect(closed, 'no closed product in the dataset').toBeTruthy();
		await page.getByRole('combobox').fill(closed!);
		// The list renders in the same task as the input event, so it is current here. Another
		// product may match fuzzily; only the closed one's own name must be missing.
		const labels = await page
			.getByRole('option')
			.locator('.font-mono')
			.evaluateAll((els) => els.map((e) => e.textContent?.trim()));
		expect(labels).not.toContain(closed);
	});

	test('every form control has a programmatic label; the search box is named "Search open(ish) products or organizations"', async ({
		page
	}) => {
		await openMap(page);
		await expect(
			page.getByRole('combobox', { name: 'Search open(ish) products or organizations' })
		).toBeVisible();
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

test.describe('gap map layout, 1280×720', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1280, height: 720 } });

	test("nothing fixed on screen covers a row's products at 1280×720 (CUR-1648)", async ({
		page
	}) => {
		await openMap(page);
		for (const y of [0, 600, 1400]) {
			await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
			const overlaps = await page.evaluate(() => {
				const cells = [
					...document.querySelectorAll<HTMLElement>('#map section button > div:last-child')
				]
					.map((el) => el.getBoundingClientRect())
					.filter((r) => r.bottom > 0 && r.top < innerHeight);
				const fixed = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
					if (el.closest('body > div header, [data-sveltekit-preload-data] > header')) return false;
					const st = getComputedStyle(el);
					return (
						st.position === 'fixed' &&
						st.display !== 'none' &&
						st.visibility !== 'hidden' &&
						el.offsetWidth > 0
					);
				});
				const hits: string[] = [];
				for (const el of fixed) {
					const r = el.getBoundingClientRect();
					if (
						cells.some(
							(c) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top
						)
					)
						hits.push(`${el.tagName}.${el.className}`.slice(0, 100));
				}
				return hits;
			});
			expect(overlaps, `a fixed element covers product squares at scrollY ${y}`).toEqual([]);
		}
	});
});

// As the bar narrows the legend shortens its labels, then goes; the button always stays. The phone
// test below covers the bar with no legend.
for (const { width, shapes, strip } of [
	{ width: 1280, shapes: 'Open source Open-ish', strip: 'Product score' },
	{ width: 1000, shapes: 'Open Open-ish', strip: 'Score' }
]) {
	test.describe(`gap map layout, ${width}px wide`, { tag: '@G1' }, () => {
		test.use({ viewport: { width, height: 800 } });

		test(`the bar's legend reads "${shapes} ${strip}", beside the button`, async ({ page }) => {
			await openMap(page);
			const bar = page.getByTestId('layer-bar');
			await expect(bar.getByTestId('legend-shapes')).toHaveText(shapes, { useInnerText: true });
			await expect(bar.getByTestId('legend-strip')).toHaveText(strip, { useInnerText: true });
			await expect(bar.getByRole('button', { name: 'How to read the map' })).toBeVisible();
		});
	});
}

// The legend hides below an 880px bar (55rem): the window less 4vw of padding each side, about
// 957px. At 900px the short legend would clip the Infrastructure tab.
test.describe('gap map layout, 900px wide', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 900, height: 800 } });

	test("the bar's legend is gone below a 957px window, the button stays", async ({ page }) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		await expect(bar.getByTestId('legend-shapes')).toBeHidden();
		await expect(bar.getByTestId('legend-strip')).toBeHidden();
		await expect(bar.getByRole('button', { name: 'How to read the map' })).toHaveText(
			'How to read the map',
			{ useInnerText: true }
		);
	});
});

/**
 * Opens the side panel of the first product square in the Product / UX layer and waits until it
 * names that product. A row's stage pill and gap icons are images inside the same row button, and
 * clicking one of those opens the category panel instead.
 */
async function openProductPanel(page: Page) {
	const square = page
		.locator(
			'#layer-product_ux [role="img"][aria-label]:not([aria-label^="Maturity stage"]):not([aria-label$=" gap"])'
		)
		.first();
	const name = (await square.getAttribute('aria-label'))!;
	await square.click();
	const panel = page.locator('aside').filter({ hasText: /product in the .* category/i });
	await expect(panel).toContainText(name);
}

/**
 * What the layer bar cuts off: the tabs that end past the tab strip's right edge, and whether the
 * legend button ends past the bar's.
 */
async function barClipping(page: Page) {
	return page.getByTestId('layer-bar').evaluate((bar) => {
		const nav = bar.querySelector('nav[aria-label="Layers"]')!.getBoundingClientRect().right;
		const button = bar.querySelector('button[aria-label="How to read the map"]')!;
		return {
			tabs: [...bar.querySelectorAll('nav[aria-label="Layers"] a')]
				.filter((a) => a.getBoundingClientRect().right > nav + 0.5)
				.map((a) => a.textContent?.trim()),
			button: button.getBoundingClientRect().right > bar.getBoundingClientRect().right + 0.5
		};
	});
}

// A product panel takes a column from the map, so the bar is narrower than the window says; the
// legend gives way rather than clip "Infrastructure" or push its button out of the bar.
for (const width of [1024, 1280]) {
	test.describe(`gap map layout, ${width}px wide with a product panel open`, { tag: '@G1' }, () => {
		test.use({ viewport: { width, height: 800 } });

		test('every layer tab and the legend button are shown whole', async ({ page }) => {
			await openMap(page);
			const bar = page.getByTestId('layer-bar');
			const before = (await bar.boundingBox())!.width;
			await openProductPanel(page);
			// The panel is open once it has narrowed the bar and the bar has stopped moving; a clip
			// measured before that proves nothing.
			await expect
				.poll(
					() =>
						bar.evaluate(
							(el) =>
								new Promise<number>((done) => {
									const w = el.getBoundingClientRect().width;
									setTimeout(
										() => done(el.getBoundingClientRect().width === w ? w : Infinity),
										150
									);
								})
						),
					{ message: 'the product panel never opened' }
				)
				.toBeLessThan(before - 300);
			await expect.poll(() => barClipping(page)).toEqual({ tabs: [], button: false });
			await expect(bar.getByRole('button', { name: 'How to read the map' })).toBeVisible();
		});
	});
}

// The header row keeps every label on one line; a narrow chart shortens the first two labels
// and narrows their columns (in px: 8rem and 7rem wide, 5.5rem and 5rem narrow).
for (const { width, labels, stageGaps } of [
	{
		width: 1280,
		labels: ['Maturity', 'Gaps found', 'Category', 'Open(ish) products ordered by score'],
		stageGaps: [128, 112]
	},
	{
		width: 800,
		labels: ['Maturity', 'Gaps', 'Category', 'Open(ish) products ordered by score'],
		stageGaps: [88, 80]
	}
]) {
	test.describe(`gap map column headers, ${width}px wide`, { tag: '@G1' }, () => {
		test.use({ viewport: { width, height: 800 } });

		test(`the header reads "${labels.join(' / ')}", each label on one line, stage and gaps ${stageGaps.join('px and ')}px wide`, async ({
			page
		}) => {
			await openMap(page);
			const cells = page.getByTestId('layer-column-header').first().locator('> span');
			const seen = await cells.evaluateAll((els) =>
				els.map((el) => ({
					// The visible label, without the active column's arrow and its screen-reader text.
					text: (el.querySelector('button > span') as HTMLElement).innerText.trim().toLowerCase(),
					// The label is the button's content box: its padding is not a line of text.
					lines: (() => {
						const b = el.querySelector('button')!;
						const s = getComputedStyle(b);
						const content =
							b.getBoundingClientRect().height -
							parseFloat(s.paddingTop) -
							parseFloat(s.paddingBottom);
						return Math.round(content / parseFloat(s.lineHeight));
					})(),
					clipped: [el, ...el.querySelectorAll('button, button > span:not(.sr-only)')].some(
						(n) => n.scrollWidth > n.clientWidth
					),
					width: Math.round(el.getBoundingClientRect().width)
				}))
			);
			expect(seen.slice(0, 2).map((s) => s.width)).toEqual(stageGaps);
			expect(seen.map((s) => s.text)).toEqual(labels.map((l) => l.toLowerCase()));
			for (const s of seen) {
				expect(s.lines, `"${s.text}" wraps`).toBe(1);
				expect(s.clipped, `"${s.text}" is cut off`).toBe(false);
			}
		});

		test('the active column shows its arrow inside its cell, even in the narrow stage and gaps columns', async ({
			page
		}) => {
			for (const id of ['stage', 'gaps']) {
				await page.goto(`${GAP_MAP}?sort=${id}&dir=asc`, { waitUntil: 'domcontentloaded' });
				const cell = page
					.getByTestId('layer-column-header')
					.first()
					.locator('> span')
					.nth(id === 'stage' ? 0 : 1);
				const arrow = cell.getByText('↓', { exact: true });
				await expect(arrow).toBeVisible({ timeout: 30_000 });
				const [a, c] = await Promise.all([arrow.boundingBox(), cell.boundingBox()]);
				expect(a!.x + a!.width, `the ${id} arrow runs past its cell`).toBeLessThanOrEqual(
					c!.x + c!.width
				);
			}
		});
	});
}

// Below 768px (spec §10): the same markup, switched by CSS.
test.describe('gap map layout, phone', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	test('the page never scrolls sideways', async ({ page }) => {
		await openMap(page);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, 'the page is wider than the phone').toBeLessThanOrEqual(0);
	});

	test('rows show the stage on the left and the gaps before the name, both level with its first line; no header rows; outlined squares as one count', async ({
		page
	}) => {
		await openMap(page);
		await expect(page.getByTestId('layer-column-header').first()).toBeHidden();
		const rows = page.getByRole('button').filter({ hasText: /\d+ open\(ish\) products/ });
		const n = await rows.count();
		expect(n).toBeGreaterThan(10);
		for (let i = 0; i < n; i++) {
			const row = rows.nth(i);
			const pill = row.getByRole('img', { name: /^Maturity stage [0-5] of 5$/ });
			const name = row.locator('div.uppercase').first();
			await expect(pill).toBeVisible();
			const [p, nm] = await Promise.all([pill.boundingBox(), name.boundingBox()]);
			expect(p!.x + p!.width, `row ${i}: the pill is not before the name`).toBeLessThanOrEqual(
				nm!.x
			);
			// The name's first line is 20px (16px type, leading-tight).
			const firstLineMid = nm!.y + 10;
			expect(
				Math.abs(p!.y + p!.height / 2 - firstLineMid),
				`row ${i}: the pill is not level with the name's first line`
			).toBeLessThanOrEqual(2);
			const cap = (await row.getByTestId('row-caption').boundingBox())!;
			expect(
				cap.y - (nm!.y + nm!.height),
				`row ${i}: the caption sits tight under the name`
			).toBeGreaterThanOrEqual(5);
			for (const gap of await row.getByRole('img', { name: / gap$/ }).all()) {
				const g = (await gap.boundingBox())!;
				expect(g.x, `row ${i}: a gap diamond is left of the pill`).toBeGreaterThanOrEqual(
					p!.x + p!.width
				);
				expect(g.x + g.width, `row ${i}: a gap diamond is not before the name`).toBeLessThanOrEqual(
					nm!.x
				);
				expect(
					Math.abs(g.y + g.height / 2 - firstLineMid),
					`row ${i}: a gap diamond is not level with the name's first line`
				).toBeLessThanOrEqual(2);
			}

			// On a phone the caption shows only the leading and strong counts; the total it leaves out
			// is still in the DOM, hidden, and is what the outlined count is checked against.
			const captionEl = row.getByTestId('row-caption');
			await expect(captionEl).toHaveText(
				/^(none leading or strong|\d+ leading(, \d+ strong)?|\d+ strong)$/,
				{ useInnerText: true }
			);
			const caption = (await captionEl.textContent())!.trim();
			const open = Number(caption.match(/^(\d+)/)![1]);
			const leading = Number(caption.match(/(\d+) leading/)?.[1] ?? 0);
			const strong = Number(caption.match(/(\d+) strong/)?.[1] ?? 0);
			const outlined = open - leading - strong;
			const count = row.getByTestId('outline-count');
			if (outlined === 0) await expect(count).toHaveCount(0);
			else {
				await expect(count, `row ${i}: "${caption}"`).toHaveText(
					`${leading + strong > 0 ? '+' : ''}${outlined} available`
				);
				// Set like the caption above it, in the gap triangles' red rather than grey.
				const type = (el: Element) => {
					const s = getComputedStyle(el);
					return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight];
				};
				expect(await count.evaluate(type), `row ${i}: the count's type`).toEqual(
					await captionEl.evaluate(type)
				);
				await expect(count).toHaveCSS('color', 'rgb(223, 0, 0)');
			}
			const visibleOutlines = await row
				.getByRole('img')
				.evaluateAll(
					(els) =>
						els.filter(
							(el) =>
								el.tagName === 'DIV' &&
								el.querySelector('svg, [style*="border"]') &&
								el.checkVisibility()
						).length
				);
			expect(visibleOutlines, `row ${i}: outlined squares still drawn`).toBe(0);
		}
	});

	test('the bar holds the tabs and a "Legend" button, which opens the guide as a bottom sheet', async ({
		page
	}) => {
		await openMap(page);
		const bar = page.getByTestId('layer-bar');
		await expect(bar.getByTestId('legend-shapes')).toBeHidden();
		await expect(bar.getByTestId('legend-strip')).toBeHidden();
		const button = bar.getByRole('button', { name: 'How to read the map' });
		expect((await button.innerText()).trim(), 'the button does not read "Legend" on a phone').toBe(
			'Legend'
		);
		await button.tap();
		const sheet = page.getByRole('dialog', { name: 'How to read the map' });
		await expect(sheet).toBeVisible();
		const box = (await sheet.boundingBox())!;
		expect(Math.round(box.width)).toBe(390);
		expect(Math.round(box.y + box.height), 'the sheet is not anchored to the bottom').toBe(844);
	});

	test('a tap on a row opens the full-screen category panel and never a tooltip', async ({
		page
	}) => {
		await openMap(page);
		await page.getByText('Fine-tuned / chat models', { exact: true }).tap();
		const panel = page.locator('aside').filter({ hasText: 'Category in the' });
		await expect(panel.getByRole('heading', { name: /Fine-tuned \/ chat models/i })).toBeVisible();
		await expect(page.getByRole('tooltip')).toHaveCount(0);
		const content = panel.locator('> div').last();
		expect(Math.round((await content.boundingBox())!.width)).toBe(390);
	});
});
