// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// The gap map and the full dataset are two views of one dataset that share a header —
// a breadcrumb back to the map intro, a toggle between the two views, and four figures, each
// linking to the page that shows it. Figures are compared by shape and across pages, never pinned:
// they change every time the catalog is rescored.

const GAP_MAP = '/map/gap-map';
const DATASET = '/map/dataset';
const LONG_TAIL = '/map/notebooks?tab=long-tail-explorer';

async function open(page: Page, path: string) {
	const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `${path} answered ${res?.status()}`).toBe(200);
	await expect(page.getByTestId('map-header')).toBeVisible({ timeout: 30_000 });
}

/** The header's figures as { label → { value, href } }, the `›` link suffix stripped. */
async function readKpis(page: Page) {
	const rows = await page
		.getByTestId('map-header')
		.getByTestId('map-kpi')
		.evaluateAll((els) =>
			els.map((el) => ({
				label:
					el
						.querySelector('dt')
						?.textContent?.replace(/\s*›\s*$/, '')
						.trim() ?? '',
				value: el.querySelector('dd')?.textContent?.trim() ?? '',
				href: el.querySelector('dt a')?.getAttribute('href') ?? null
			}))
		);
	return Object.fromEntries(rows.map((r) => [r.label, { value: r.value, href: r.href }]));
}

test.describe('the gap map and full dataset share one header', { tag: '@G1' }, () => {
	for (const { path, title } of [
		{ path: GAP_MAP, title: 'gap map' },
		{ path: DATASET, title: 'dataset' }
	]) {
		test(`the ${title}'s breadcrumb leads back to the gap map introduction`, async ({ page }) => {
			await open(page, path);
			const crumb = page.getByTestId('map-header').getByRole('link', {
				name: 'Gap Map introduction'
			});
			await expect(crumb).toBeVisible();
			// The intro is whichever map-template page the view sits under, so the target is read
			// from the link, then checked to be a page that answers, outside both views.
			const href = (await crumb.getAttribute('href')) ?? '';
			expect(href, 'the breadcrumb points back into one of the two views').not.toMatch(
				new RegExp(`^(${GAP_MAP}|${DATASET})`)
			);
			const res = await page.request.get(href);
			expect(res.status(), `the breadcrumb's ${href} answered ${res.status()}`).toBe(200);
			await crumb.click();
			await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), {
				timeout: 20_000
			});
		});
	}

	test('the toggle moves between the two views and marks the one you are on', async ({ page }) => {
		await open(page, GAP_MAP);
		const toggle = page.getByRole('navigation', { name: 'Map views' });
		await expect(toggle.getByRole('link', { name: 'Open source Gap Map' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await toggle.getByRole('link', { name: 'Full dataset' }).click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
		await expect(
			page
				.getByRole('navigation', { name: 'Map views' })
				.getByRole('link', { name: 'Full dataset' })
		).toHaveAttribute('aria-current', 'page');

		await page
			.getByRole('navigation', { name: 'Map views' })
			.getByRole('link', { name: 'Open source Gap Map' })
			.click();
		await expect(page).toHaveURL(new RegExp(`${GAP_MAP}$`), { timeout: 20_000 });
	});

	test('each figure links to the page that shows it, except the page you are on', async ({
		page
	}) => {
		await open(page, GAP_MAP);
		const onMap = await readKpis(page);
		expect(Object.keys(onMap)).toEqual([
			'Total products mapped',
			'Assessed products',
			'Open(ish) products',
			'Gaps to fill'
		]);
		expect(onMap['Total products mapped'].href).toBe(LONG_TAIL);
		expect(onMap['Assessed products'].href).toBe(DATASET);
		expect(onMap['Open(ish) products'].href, 'the gap map links to itself').toBeNull();
		expect(onMap['Gaps to fill'].href).toBeNull();

		await open(page, DATASET);
		const onDataset = await readKpis(page);
		expect(onDataset['Assessed products'].href, 'the dataset links to itself').toBeNull();
		expect(onDataset['Open(ish) products'].href).toBe(GAP_MAP);

		for (const label of Object.keys(onMap)) {
			expect(onMap[label].value, `${label} is not a number`).toMatch(/^\d[\d,]*$/);
			expect(
				onDataset[label]?.value,
				`the two views give different figures for "${label}" from the same dataset`
			).toBe(onMap[label].value);
		}
	});

	test('a figure link takes you to its page', async ({ page }) => {
		await open(page, GAP_MAP);
		await page
			.getByTestId('map-header')
			.getByRole('link', { name: /Assessed products/ })
			.click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
		await page
			.getByTestId('map-header')
			.getByRole('link', { name: /Open\(ish\) products/ })
			.click();
		await expect(page).toHaveURL(new RegExp(`${GAP_MAP}$`), { timeout: 20_000 });
	});

	test('See all assessed products opens the dataset on that category, in view, with the others collapsed', async ({
		page
	}) => {
		await open(page, GAP_MAP);
		// A click before hydration does nothing; the layer bar marks a tab only from client code.
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{ timeout: 30_000 }
		);
		// The last row of the first layer, so the dataset has to scroll to it.
		await page
			.locator('#layer-product_ux')
			.getByRole('button')
			.filter({ hasText: /\d+ open\(ish\) products/ })
			.last()
			// The caption, not the row's centre, which is a product square that opens the product.
			.getByText(/\d+ open\(ish\) products/)
			.click();
		const link = page.getByRole('link', { name: 'See all assessed products' });
		await expect(link).toBeVisible();
		const label = (await page.locator('aside h2').first().textContent())!.trim();
		await link.click();
		await expect(page).toHaveURL(/\/map\/dataset\?.*category=/, { timeout: 20_000 });
		const expanded = page.locator('[data-testid="category"] > button[aria-expanded="true"]');
		await expect(expanded).toHaveCount(1);
		await expect(expanded.getByTestId('category-label')).toHaveText(label);
		await expect(expanded).toBeInViewport();
	});

	test("the gap map's header carries no What's new rail or CTA tiles", async ({ page }) => {
		await open(page, GAP_MAP);
		await expect(page.getByRole('button', { name: /what.s new/i })).toHaveCount(0);
		await expect(page.getByTestId('map-header').locator('ul')).toHaveCount(0);
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
 * The block types the CMS gave a page, in order, read from SvelteKit's serialized load data for
 * it (`<path>/__data.json`): the page's own data node is the one whose root carries `page`, and
 * each entry of `page.blocks` points at an object whose `blockType` points at its type string.
 */
async function cmsBlockTypes(page: Page, path: string): Promise<string[]> {
	const res = await page.request.get(`${path}/__data.json`);
	expect(res.ok(), `${path}/__data.json answered ${res.status()}`).toBe(true);
	const { nodes } = (await res.json()) as { nodes: ({ type: string; data: unknown[] } | null)[] };
	for (const node of nodes) {
		if (node?.type !== 'data') continue;
		const flat = node.data as Record<string, number>[];
		if (!flat[0] || typeof flat[0] !== 'object' || !('page' in flat[0])) continue;
		const doc = flat[flat[0].page] as Record<string, number>;
		const blocks = (flat[doc.blocks] as unknown as number[] | undefined) ?? [];
		return blocks.map((i) => flat[flat[i].blockType] as unknown as string);
	}
	throw new Error(`${path}/__data.json carries no page data`);
}

/**
 * Each FAQs block's box in page coordinates, the last layer section's bottom edge, and the page's
 * own width (the viewport less any scrollbar).
 */
async function faqPlacement(page: Page) {
	return page.evaluate(() => {
		const layers = document.querySelectorAll(
			'#map section[id^="layer-"], main section[id^="layer-"]'
		);
		return {
			faqs: [...document.querySelectorAll('[data-block="faqs"]')].map((el) => {
				const r = el.getBoundingClientRect();
				return { top: r.top + scrollY, left: r.left, width: r.width };
			}),
			lastLayerBottom: layers[layers.length - 1].getBoundingClientRect().bottom + scrollY,
			pageWidth: document.documentElement.clientWidth
		};
	});
}

/** Every FAQs block the page draws sits below the last layer and spans the whole page. */
function expectFaqsBelowAndFullWidth(at: Awaited<ReturnType<typeof faqPlacement>>) {
	for (const faq of at.faqs) {
		expect(faq.top, 'a FAQ is not below the last layer').toBeGreaterThanOrEqual(at.lastLayerBottom);
		expect(Math.round(faq.left)).toBe(0);
		expect(Math.round(faq.width)).toBe(at.pageWidth);
	}
}

// The FAQ is editor content: a Payload FAQs block ("About the Gap Map") on each page, present in a
// given environment only once an editor adds it. So these assert the rendering contract against
// what that environment's CMS holds: the page draws exactly the FAQs blocks its CMS document
// carries, each below the last layer at full page width. With no block in the CMS they assert none
// renders, and the annotation says the placement checks had nothing to measure.
test.describe('the FAQ below both views', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	for (const path of [GAP_MAP, DATASET]) {
		test(`${path}: draws every FAQs block its CMS document carries, below the last layer, across the full page width`, async ({
			page
		}) => {
			const expected = (await cmsBlockTypes(page, path)).filter((t) => t === 'faqs').length;
			await open(page, path);
			await expect(page.locator('[data-block="faqs"]')).toHaveCount(expected);
			if (expected === 0) {
				test.info().annotations.push({
					type: 'content',
					description: `${path} has no FAQs block in this environment's CMS; asserted none renders`
				});
				return;
			}
			await expect(
				page.locator('[data-block="faqs"]').first().getByRole('heading', { level: 2 })
			).toBeVisible();
			expectFaqsBelowAndFullWidth(await faqPlacement(page));
		});
	}

	test('with a product panel open, the gap map FAQ still spans the whole page', async ({
		page
	}) => {
		const expected = (await cmsBlockTypes(page, GAP_MAP)).filter((t) => t === 'faqs').length;
		await open(page, GAP_MAP);
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{
				timeout: 30_000
			}
		);
		const map = page.locator('#map');
		const before = (await map.boundingBox())!.width;
		await openProductPanel(page);
		await expect
			.poll(async () => (await map.boundingBox())!.width, {
				message: 'the product panel never opened'
			})
			.toBeLessThan(before - 300);
		const at = await faqPlacement(page);
		expect(at.faqs).toHaveLength(expected);
		if (expected === 0)
			test.info().annotations.push({
				type: 'content',
				description: `${GAP_MAP} has no FAQs block in this environment's CMS; nothing to measure`
			});
		expectFaqsBelowAndFullWidth(at);
	});
});

test.describe('the shared header on a 375px phone', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 375, height: 800 } });

	for (const path of [GAP_MAP, DATASET]) {
		test(`${path}: both toggle labels show in full, inside the screen`, async ({ page }) => {
			await open(page, path);
			const links = page.getByRole('navigation', { name: 'Map views' }).getByRole('link');
			await expect(links).toHaveCount(2);
			for (const link of await links.all()) {
				const fit = await link.evaluate((el) => ({
					label: el.textContent?.trim(),
					clipped: el.scrollWidth > el.clientWidth,
					right: el.getBoundingClientRect().right
				}));
				expect(fit.clipped, `"${fit.label}" is wider than its button`).toBe(false);
				expect(fit.right, `"${fit.label}" runs off the screen`).toBeLessThanOrEqual(375);
			}
		});

		test(`${path}: a header link's › stays on the line its label ends on`, async ({ page }) => {
			await open(page, path);
			const links = page.getByTestId('map-header').locator('a:has(> span)');
			await expect(links).not.toHaveCount(0);
			const lines = await links.evaluateAll((els) =>
				els.map((a) => {
					// The label's last character and the › after it, each as its own line box.
					const label = a.querySelector('span')!.firstChild as Text;
					const end = document.createRange();
					end.setStart(label, label.length - 1);
					end.setEnd(label, label.length);
					const arrowNode = [...a.childNodes].find(
						(n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes('›')
					) as Text;
					const arrow = document.createRange();
					const at = arrowNode.textContent!.indexOf('›');
					arrow.setStart(arrowNode, at);
					arrow.setEnd(arrowNode, at + 1);
					return {
						label: a.textContent!.trim(),
						labelLine: Math.round(end.getBoundingClientRect().top),
						arrowLine: Math.round(arrow.getBoundingClientRect().top)
					};
				})
			);
			for (const l of lines)
				expect(l.arrowLine, `"${l.label}" wraps before its ›`).toBe(l.labelLine);
		});

		// Each figure renders bottom-up (flex-col-reverse), so in a cell stretched to its
		// row a neighbour's two-line label pushes the number down.
		test(`${path}: the figures in each row of the header start on one line`, async ({ page }) => {
			await open(page, path);
			const figures = await page
				.getByTestId('map-header')
				.getByTestId('map-kpi')
				.evaluateAll((els) =>
					els.map((el) => ({
						label: el.querySelector('dt')!.textContent!.trim(),
						cellTop: Math.round(el.getBoundingClientRect().top),
						numberTop: Math.round(el.querySelector('dd')!.getBoundingClientRect().top),
						labelHeight: Math.round(el.querySelector('dt')!.getBoundingClientRect().height)
					}))
				);
			expect(figures).toHaveLength(4);
			const rows = [figures.slice(0, 2), figures.slice(2, 4)];
			for (const [left, right] of rows) {
				expect(right.cellTop, `"${left.label}" and "${right.label}" share no row`).toBe(
					left.cellTop
				);
				expect(
					right.numberTop,
					`the number above "${right.label}" sits lower than the one above "${left.label}"`
				).toBe(left.numberTop);
			}
			// The check only bites on a row whose two labels differ in height.
			if (rows.every(([l, r]) => l.labelHeight === r.labelHeight))
				test.info().annotations.push({
					type: 'coverage',
					description: `${path}: no row has labels of different heights at 375px; alignment held trivially`
				});
		});
	}
});

/** Opens a view and waits for hydration: the layer bar marks a tab only from client code. */
async function openHydrated(page: Page, path: string) {
	await open(page, path);
	await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(1, {
		timeout: 30_000
	});
}

const expandedIn = (page: Page, scope: string) =>
	page.locator(`${scope} [data-testid="category"] > button[aria-expanded="true"]`);

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

// CUR-3907 (Gap Map item 3, Dataset item 11), CUR-4271: a product or org page's back link returns
// to the map view, product or org page the visitor came from, as they left it. From anywhere else
// it is the fixed Gap Map link, never a history step that could leave the site.
test.describe('Back from a product or org page', { tag: '@G1' }, () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('a visitor from / reaches a product through both views and the back link returns them to the dataset as they left it', async ({
		page
	}) => {
		// This test checks where each link leads, so it runs under reduced motion. With motion allowed,
		// the page being left stays in the DOM through the view transition, and ScrollSmoother's lag
		// moves a link after Playwright scrolls to it, so a click can miss for the whole timeout (CUR-4303).
		// smooth-scroll.spec.ts and page-transition.spec.ts cover the motion.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		// The home page links to the map intro or straight to the gap map, depending on CMS content.
		await page.locator('main a[href="/map"], main a[href="/map/gap-map"]').first().click();
		await page.waitForURL(/\/map(\/gap-map)?$/, { timeout: 30_000 });
		// By target: the home page's own "Explore the Gap Map" links to /map.
		if (!new URL(page.url()).pathname.endsWith(GAP_MAP))
			await page.locator(`main a[href="${GAP_MAP}"]`).first().click();
		await expect(page).toHaveURL(new RegExp(`${GAP_MAP}$`), { timeout: 30_000 });
		await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
			1,
			{ timeout: 30_000 }
		);

		await page
			.getByRole('navigation', { name: 'Map views' })
			.getByRole('link', { name: 'Full dataset' })
			.click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
		await page.locator('#layer-product_ux').getByRole('button', { name: 'Collapse all' }).click();
		await expect(expandedIn(page, '#layer-product_ux')).toHaveCount(0);
		await page
			.locator('#layer-model_components tr[data-product-id]')
			.first()
			.getByTestId('product-name')
			.click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });

		await page.getByRole('link', { name: 'Back to the full dataset' }).click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
		// The open categories first: on the product page, before the dataset renders, no category
		// is open either. Back changes the URL before the dataset's data has loaded, so this waits
		// as long as the navigations above.
		await expect(expandedIn(page, '#layer-model_components').first()).toBeVisible({
			timeout: 20_000
		});
		await expect(expandedIn(page, '#layer-product_ux')).toHaveCount(0);

		// A fresh visit, through the toggle, opens every category again.
		const views = page.getByRole('navigation', { name: 'Map views' });
		await views.getByRole('link', { name: 'Open source Gap Map' }).click();
		await expect(page).toHaveURL(new RegExp(`${GAP_MAP}$`), { timeout: 20_000 });
		await views.getByRole('link', { name: 'Full dataset' }).click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
		await expect(
			page.locator('#layer-product_ux [data-testid="category"] > button')
		).not.toHaveCount(0);
		await expect(
			page.locator('#layer-product_ux [data-testid="category"] > button[aria-expanded="false"]')
		).toHaveCount(0);
	});

	test('the back link returns to the dataset with its filter, sort, collapsed categories and scroll', async ({
		page
	}) => {
		await openHydrated(page, DATASET);
		const openFilter = page
			.getByRole('group', { name: 'Filter by openness' })
			.getByRole('button', { name: 'Open', exact: true });
		const productHeader = page
			.locator('thead')
			.first()
			.getByRole('button', { name: /^Product/ });
		await openFilter.click();
		await expect(page).toHaveURL(/[?&]openness=open\b/);
		await productHeader.click();
		await expect(page).toHaveURL(/[?&]sort=product&dir=asc/);
		await page
			.locator('#layer-infrastructure')
			.getByRole('button', { name: 'Collapse all' })
			.click();
		await expect(expandedIn(page, '#layer-infrastructure')).toHaveCount(0);
		const expandedModels = await expandedIn(page, '#layer-model_components').count();
		expect(expandedModels, 'no model category is open').toBeGreaterThan(0);

		const row = page.locator('#layer-model_components tr[data-product-id]').last();
		await row.scrollIntoViewIfNeeded();
		const y = await scrollY(page);
		await row.getByTestId('product-name').click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });

		const back = page.getByRole('link', { name: 'Back to the full dataset' });
		// The address the visitor left, which SvelteKit's own record of it lacks after replaceState.
		const href = new URL((await back.getAttribute('href'))!, page.url());
		expect(href.pathname).toBe(DATASET);
		expect(href.searchParams.get('openness')).toBe('open');
		expect(href.searchParams.get('sort')).toBe('product');
		await back.click();

		// Back (history.back()) changes the URL before the dataset's data has loaded, so the filter
		// waits as long as openHydrated does.
		await expect(page).toHaveURL(/\/map\/dataset\?.*openness=open/, { timeout: 20_000 });
		await expect(openFilter).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
		await expect(productHeader).toContainText('↓');
		await expect(expandedIn(page, '#layer-infrastructure')).toHaveCount(0);
		await expect(expandedIn(page, '#layer-model_components')).toHaveCount(expandedModels);
		await expect
			.poll(() => scrollY(page), { message: 'the scroll was not restored' })
			.toBeGreaterThan(y - 100);
		expect(Math.abs((await scrollY(page)) - y)).toBeLessThan(100);
	});

	// The org link sits inside a row that opens the product, and must still reach
	// SvelteKit's router; a full page load leaves the org page's back link no view to return to (CUR-4271).
	test("a row's organization link opens the org page, whose back link returns to the dataset with its filter", async ({
		page
	}) => {
		await openHydrated(page, DATASET);
		const openFilter = page
			.getByRole('group', { name: 'Filter by openness' })
			.getByRole('button', { name: 'Open', exact: true });
		await openFilter.click();
		await expect(page).toHaveURL(/[?&]openness=open\b/);

		const orgLink = page.locator('tr[data-product-id] a[href^="/org/"]').first();
		const orgPath = (await orgLink.getAttribute('href'))!;
		await orgLink.click();
		await expect(page).toHaveURL(new RegExp(`${orgPath}$`), { timeout: 20_000 });

		const back = page.getByRole('link', { name: 'Back to the full dataset' });
		await expect(back, 'the org page does not know the visitor came from the dataset').toBeVisible({
			timeout: 20_000
		});
		await back.click();
		await expect(page).toHaveURL(/\/map\/dataset\?.*openness=open/, { timeout: 20_000 });
		await expect(openFilter).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
	});

	test('Back to a category deep link keeps the categories the visitor opened, rather than applying the link again', async ({
		page
	}) => {
		await openHydrated(page, DATASET);
		const ids = await page
			.getByTestId('category')
			.evaluateAll((els) => els.map((e) => e.id).filter(Boolean));
		const [first, target] = [ids[0], ids[ids.length - 1]];
		await openHydrated(page, `${DATASET}?category=${encodeURIComponent(target)}`);
		await expect(expandedIn(page, 'main')).toHaveCount(1);

		await page.locator(`[id="${first}"] > button`).click();
		await expect(expandedIn(page, 'main')).toHaveCount(2);
		const row = page.locator(`[id="${target}"] tr[data-product-id]`).first();
		await row.scrollIntoViewIfNeeded();
		const y = await scrollY(page);
		await row.getByTestId('product-name').click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });

		await page.goBack();
		await expect(page).toHaveURL(/[?&]category=/);
		await expect(page.locator(`[id="${first}"] > button`)).toHaveAttribute('aria-expanded', 'true');
		await expect(expandedIn(page, 'main')).toHaveCount(2);
		await expect
			.poll(() => scrollY(page), { message: 'the scroll was not restored' })
			.toBeGreaterThan(y - 100);
		expect(Math.abs((await scrollY(page)) - y)).toBeLessThan(100);
	});

	test('the back link returns to the gap map with its sort', async ({ page }) => {
		await openHydrated(page, GAP_MAP);
		const header = () =>
			page
				.getByTestId('layer-column-header')
				.first()
				.getByRole('button', { name: /open\(ish\) products/i });
		await header().click();
		await expect(page).toHaveURL(/[?&]sort=open&dir=desc/);

		// An open(ish) product, read from the dataset so the test is not pinned to a catalog value.
		const name = await page.evaluate(async () => {
			const html = await (await fetch('/map/dataset')).text();
			const doc = new DOMParser().parseFromString(html, 'text/html');
			return doc
				.querySelector(
					'tr[data-product-id]:not([data-bucket="closed"]) [data-testid="product-name"]'
				)
				?.textContent?.trim();
		});
		expect(name, 'no open(ish) product in the dataset').toBeTruthy();
		await page.getByRole('combobox').fill(name!);
		await page
			.getByRole('option')
			.filter({ has: page.getByText(name!, { exact: true }) })
			.first()
			.click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });

		const back = page.getByRole('link', { name: 'Back to Gap Map' });
		const href = new URL((await back.getAttribute('href'))!, page.url());
		expect(href.pathname).toBe(GAP_MAP);
		expect(href.searchParams.get('sort')).toBe('open');
		// A history step, not a new entry: following the href would load the same URL.
		const entries = await page.evaluate(() => history.length);
		await back.click();
		await expect(page).toHaveURL(/\/map\/gap-map\?.*sort=open&dir=desc/);
		expect(await page.evaluate(() => history.length), 'the back link pushed a new entry').toBe(
			entries
		);
		await expect(header()).toContainText('↑');
	});

	test('the back link names the product or org page the visitor came from, and steps back through each in turn', async ({
		page
	}) => {
		await openHydrated(page, DATASET);
		await page
			.locator('tr[data-product-id]')
			.filter({ has: page.locator('a[href^="/org/"]') })
			.first()
			.getByTestId('product-name')
			.click();
		await expect(page).toHaveURL(/\/product\//, { timeout: 20_000 });
		const productPath = new URL(page.url()).pathname;
		const productName = (await page.locator('main h1').textContent())!.trim();
		await page.locator('main header a[href^="/org/"]').click();
		await expect(page).toHaveURL(/\/org\//, { timeout: 20_000 });
		const orgPath = new URL(page.url()).pathname;

		const toProduct = page.getByRole('link', { name: `Back to ${productName}` });
		await expect(toProduct).toHaveAttribute('href', productPath, { timeout: 20_000 });
		await toProduct.click();
		await expect(page).toHaveURL(new RegExp(`${productPath}$`), { timeout: 20_000 });
		await expect(page.getByRole('link', { name: 'Back to the full dataset' })).toBeVisible({
			timeout: 20_000
		});

		// Arriving by the browser's Forward, the org page still knows it was opened from the product.
		await page.goForward();
		await expect(page).toHaveURL(new RegExp(`${orgPath}$`), { timeout: 20_000 });
		await expect(toProduct).toBeVisible({ timeout: 20_000 });
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${productPath}$`), { timeout: 20_000 });
		await page.getByRole('link', { name: 'Back to the full dataset' }).click();
		await expect(page).toHaveURL(new RegExp(`${DATASET}$`), { timeout: 20_000 });
	});

	test('a product or org page opened directly, with nothing to step back to, links to the Gap Map', async ({
		page
	}) => {
		await openHydrated(page, DATASET);
		const orgPath = (await page
			.locator('tr[data-product-id] a[href^="/org/"]')
			.first()
			.getAttribute('href'))!;
		await page.goto(orgPath, { waitUntil: 'domcontentloaded' });
		// A dataset row opens its product by script, so the product's path is read from the roster.
		const productPath = (await page
			.locator('main a[href^="/product/"]')
			.first()
			.getAttribute('href'))!;

		for (const path of [orgPath, productPath]) {
			await page.goto(path, { waitUntil: 'domcontentloaded' });
			const back = page.getByRole('link', { name: 'Back to Gap Map' });
			const fallback = (await back.getAttribute('href'))!;
			expect(fallback, 'the fallback points into the dataset').not.toContain(DATASET);
			await back.click();
			await expect(page).toHaveURL(
				new RegExp(`${fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
				{ timeout: 20_000 }
			);
			// The fallback lands on the Gap Map itself, rendered with a current layer.
			await expect(page.getByTestId('layer-bar').locator('[aria-current="location"]')).toHaveCount(
				1,
				{ timeout: 30_000 }
			);
		}
	});
});
