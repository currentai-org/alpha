// e2e-product: @site
import { test, expect } from './helpers/test';

// A page with no template renders through default-template.svelte, which sets it like the designed
// pages (Figma 1:17806): on white, the title in the hero template's serif (75px at this width) and
// centred, as on the editorial template, and the body straight on the page in a reading column
// centred under it, its lines left-aligned. One page per content shape: a long document with tables,
// a short page that opens with a heading, a document with an h6 lede, and a map page with a block
// in its text.
const PAGES = [
	{ path: '/privacy-notice', embedsBlock: false },
	{ path: '/contact', embedsBlock: false },
	{ path: '/trust-and-safety', embedsBlock: false },
	{ path: '/map/methodology', embedsBlock: true }
];

for (const { path, embedsBlock } of PAGES) {
	test(`${path} is set like the designed pages: white page, centred hero-sized serif title, left-aligned text in a centred 42rem column under it`, async ({
		page
	}) => {
		const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
		expect(res?.status(), `${path} did not load`).toBe(200);
		await expect(page.locator('main h1').first()).toBeVisible();
		await expect(page.locator('main .richtext').first()).toBeVisible();

		const m = await page.evaluate(() => {
			const px = (value: string) => parseFloat(value);
			// The colour actually behind the text: the nearest ancestor with an opaque background.
			const backgroundBehind = (el: Element | null): string => {
				for (let node = el; node; node = node.parentElement) {
					const bg = getComputedStyle(node).backgroundColor;
					if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
				}
				return 'rgb(255, 255, 255)';
			};
			const h1 = document.querySelector('main h1')!;
			const text = document.querySelector('main .richtext')!;
			const h2 = text.querySelector(':scope > h2');
			const p = text.querySelector(':scope > p');
			// The first child held to the reading column (a heading or a paragraph, not a block).
			const prose = text.querySelector(':scope > :not([data-block])')!;
			const centre = (el: Element) => {
				const r = el.getBoundingClientRect();
				return r.left + r.width / 2;
			};
			const block = text.querySelector(':scope > [data-block]');
			return {
				rem: px(getComputedStyle(document.documentElement).fontSize),
				pageBg: backgroundBehind(document.querySelector('main')),
				h1Font: getComputedStyle(h1).fontFamily,
				h1Size: px(getComputedStyle(h1).fontSize),
				h1Align: getComputedStyle(h1).textAlign,
				h1Centre: centre(h1),
				proseCentre: centre(prose),
				proseAlign: getComputedStyle(prose).textAlign,
				h2Font: h2 ? getComputedStyle(h2).fontFamily : null,
				pWidth: p ? p.getBoundingClientRect().width : null,
				blockWidth: block ? block.getBoundingClientRect().width : null
			};
		});

		expect(m.pageBg, 'the page sits on paper, not on white like the designed pages').toBe(
			'rgb(255, 255, 255)'
		);
		expect(m.h1Font, 'the title is not set in Noto Serif').toContain('Noto Serif');
		expect(
			m.h1Size,
			'the title is smaller than the hero template sets it at this width'
		).toBeGreaterThanOrEqual(4 * m.rem);
		expect(m.h1Align, 'the title is not centred, as on the editorial template').toBe('center');
		expect(
			Math.abs(m.proseCentre - m.h1Centre),
			'the reading column is not centred under the title'
		).toBeLessThanOrEqual(1);
		expect(['left', 'start'], 'the text inside the centred column is not left-aligned').toContain(
			m.proseAlign
		);
		if (m.h2Font !== null) {
			expect(m.h2Font, 'section headings are not set in Noto Serif').toContain('Noto Serif');
		}
		if (m.pWidth !== null) {
			expect(m.pWidth, 'paragraphs run past the 42rem reading measure').toBeLessThanOrEqual(
				42 * m.rem + 1
			);
		}
		if (embedsBlock) {
			expect(
				m.blockWidth,
				'the block embedded in the text is held to the reading measure instead of spanning the content'
			).toBeGreaterThan(42 * m.rem);
		}
	});
}
