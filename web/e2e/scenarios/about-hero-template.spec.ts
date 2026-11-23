// e2e-product: @site
import { test, expect } from './helpers/test';

// /about renders through the Hero page template (#2733): a light band (white, dark-blue
// text), the image in its own five columns beside the seven-column text from md and under the text
// on a phone, and the hero's buttons in their two styles, Solid (dark-blue fill, white text) and
// Outline (white fill, dark-blue border and text). The page's content comes from the CMS, so the
// checks read the rendered layout and colours, never the copy.

const DARK_BLUE = 'rgb(20, 46, 62)';
const WHITE = 'rgb(255, 255, 255)';

type HeroReading = {
	template: boolean;
	bg: string | null;
	bandColour: string;
	textColour: string;
	text: { left: number; right: number; top: number; bottom: number } | null;
	image: { left: number; right: number; top: number; bottom: number } | null;
	buttons: { bg: string; color: string; border: string }[];
};

/** Waits until the hero image has decoded, so its box is its real size and not a lazy 0x0. */
async function imageLoaded(page: import('@playwright/test').Page) {
	const img = page.locator('[data-hero-bg] img').first();
	await img.scrollIntoViewIfNeeded();
	await expect
		.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
			message: 'the hero image never loaded'
		})
		.toBe(true);
}

async function readHero(page: import('@playwright/test').Page): Promise<HeroReading> {
	await page.evaluate(() => window.scrollTo(0, 0));
	return page.evaluate(() => {
		const band = document.querySelector('[data-hero-bg]');
		const box = (el: Element | null | undefined) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		};
		return {
			template: Boolean(document.querySelector('.template-hero')),
			bg: band?.getAttribute('data-hero-bg') ?? null,
			bandColour: band ? getComputedStyle(band).backgroundColor : '',
			textColour: band ? getComputedStyle(band.querySelector('h1') ?? band).color : '',
			text: box(band?.querySelector('h1')),
			image: box(band?.querySelector('img')),
			buttons: [...(band?.querySelectorAll('a[data-slot="button"]') ?? [])].map((a) => {
				const s = getComputedStyle(a);
				return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor };
			})
		};
	});
}

test.describe('desktop width', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('/about is on the Hero template: light band, image beside the text, a Solid and an Outline button', async ({
		page
	}) => {
		const res = await page.goto('/about', { waitUntil: 'domcontentloaded' });
		expect(res?.status(), '/about did not load').toBe(200);
		await expect(page.locator('[data-hero-bg] h1')).toBeVisible();
		await imageLoaded(page);

		const hero = await readHero(page);
		expect(hero.template, '/about is not rendered by the Hero template').toBe(true);
		expect(hero.bg, 'the hero band is not the light variant the About page is set to').toBe(
			'light'
		);
		expect(hero.bandColour, 'the light hero band is not white').toBe(WHITE);
		expect(hero.textColour, 'the title on the light band is not dark blue').toBe(DARK_BLUE);

		expect(hero.text && hero.image, 'the hero has no title or no image').toBeTruthy();
		expect(
			hero.image!.left,
			'the image is not in its own column to the right of the text'
		).toBeGreaterThanOrEqual(hero.text!.right - 1);

		const solid = hero.buttons.find((b) => b.bg === DARK_BLUE);
		const outline = hero.buttons.find((b) => b.bg === WHITE);
		expect(
			solid,
			`no Solid button (dark-blue fill) among ${JSON.stringify(hero.buttons)}`
		).toBeTruthy();
		expect(solid!.color, 'the Solid button text is not white').toBe(WHITE);
		expect(
			outline,
			`no Outline button (white fill) among ${JSON.stringify(hero.buttons)}`
		).toBeTruthy();
		expect(outline!.color, 'the Outline button text is not dark blue').toBe(DARK_BLUE);
		expect(outline!.border, 'the Outline button has no dark-blue border').toBe(DARK_BLUE);
	});
});

test.describe('phone width', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('/about on a phone stacks the hero image under the text, inside the window', async ({
		page
	}) => {
		const res = await page.goto('/about', { waitUntil: 'domcontentloaded' });
		expect(res?.status(), '/about did not load').toBe(200);
		await expect(page.locator('[data-hero-bg] h1')).toBeVisible();
		await imageLoaded(page);

		const hero = await readHero(page);
		expect(hero.text && hero.image, 'the hero has no title or no image').toBeTruthy();
		expect(hero.image!.top, 'the image is not under the text on a phone').toBeGreaterThanOrEqual(
			hero.text!.bottom - 1
		);
		expect(
			hero.image!.right,
			'the image runs past the right edge of the window'
		).toBeLessThanOrEqual(390 + 1);
	});
});
