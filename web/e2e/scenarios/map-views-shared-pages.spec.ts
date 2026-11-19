// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// The Gap Map, the Full dataset and the methodology are one section with one way back and one
// call for help: the map intro's "Help us improve the map" block closes both views, and
// the methodology links up to the intro as the views do. Nothing here pins copy: the block's title
// and the intro's address are read from the pages that own them.

const INTRO = '/map';
const VIEWS = ['/map/gap-map', '/map/dataset'];
const METHODOLOGY = '/map/methodology';

async function open(page: Page, path: string) {
	const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
	expect(res?.status(), `${path} answered ${res?.status()}`).toBe(200);
}

/** The intro's call-to-action block: its title, and the address each of its links goes to. */
async function introHelpBlock(page: Page) {
	await open(page, INTRO);
	const block = page.locator('[data-block="callToActions"]').first();
	await expect(block, 'the map intro carries a call-to-action block').toBeVisible({
		timeout: 30_000
	});
	return {
		title: ((await block.getByRole('heading', { level: 2 }).textContent()) ?? '').trim(),
		hrefs: await block
			.getByRole('link')
			.evaluateAll((els) => els.map((a) => a.getAttribute('href')))
	};
}

test.describe('the map views and methodology share the intro', { tag: '@G1' }, () => {
	for (const view of VIEWS) {
		test(`${view} closes with the intro's call to improve the map, and its links lead somewhere`, async ({
			page
		}) => {
			const help = await introHelpBlock(page);
			expect(help.title.length, 'the intro block has a title').toBeGreaterThan(0);
			expect(help.hrefs.length, 'the intro block has links').toBeGreaterThan(0);

			await open(page, view);
			const block = page.locator('[data-block="callToActions"]');
			await expect(block, 'one call-to-action block, the intro one').toHaveCount(1, {
				timeout: 30_000
			});
			await expect(block.getByRole('heading', { level: 2 })).toHaveText(help.title);
			const hrefs = await block
				.getByRole('link')
				.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
			expect(hrefs, 'the same links as the intro block').toEqual(help.hrefs);

			// It follows the view's own content (the header, then the tables), and the page's closing
			// email signup stays after it. Document order, since the gap map draws its blocks outside <main>.
			const order = await page.evaluate(() => {
				const follows = (a: Element | null, b: Element | null) =>
					!!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
				const header = document.querySelector('[data-testid="map-header"]');
				const cta = document.querySelector('[data-block="callToActions"]');
				const signup = document.querySelector('[data-block="email-signup"]');
				return {
					afterHeader: follows(header, cta),
					belowHeader:
						(cta?.getBoundingClientRect().top ?? 0) >
						(header?.getBoundingClientRect().bottom ?? Infinity) + 400,
					signupAfter: signup ? follows(cta, signup) : true
				};
			});
			expect(order.afterHeader, 'after the view header').toBe(true);
			expect(order.belowHeader, 'a screen or more below the header, past the tables').toBe(true);
			expect(order.signupAfter, 'before the email signup').toBe(true);
		});
	}

	test('the methodology links up to the map introduction, and the link goes there', async ({
		page
	}) => {
		await open(page, METHODOLOGY);
		const crumb = page.getByTestId('map-intro-link');
		await expect(crumb).toBeVisible({ timeout: 30_000 });
		await expect(crumb).toHaveText('Gap Map introduction');
		// The map's own page, not one of the views it introduces.
		await expect(crumb).toHaveAttribute('href', INTRO);
		await crumb.click();
		await expect(page).toHaveURL(new RegExp(`${INTRO}$`), { timeout: 20_000 });
		await expect(page.locator('[data-block="callToActions"]').first()).toBeVisible();
	});

	test('a page outside the map section shows no link to the map introduction', async ({ page }) => {
		await open(page, '/updates');
		await expect(page.getByTestId('map-intro-link')).toHaveCount(0);
	});
});
