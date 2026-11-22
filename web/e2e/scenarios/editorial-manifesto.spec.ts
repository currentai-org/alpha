// e2e-product: @site
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/test';

// The Editorial page template (#2746, #3031), on the page it was built for: the
// manifesto at /about/manifesto. A visitor reaches it from the site navigation through About, and
// the page renders the template's parts: a back link to its parent, a centred serif title, one
// column of serif body text with section headings, its images loaded inside the column, a captioned
// image, and the column ending on the signature image. The content is the CMS's, so the checks read
// structure and type, never copy.

// A real mouse click, aimed once the link has stopped moving. The site's smooth scroller
// (`scroll-smoothed`, smooth-scroll.ts) keeps shifting content blocks after Playwright's own scroll,
// so a click aimed at the box it measured can land beside the link and leave the page on
// /about. The click stays a pointer click, so an overlay that swallows it still fails the spec.
// Stable means the box is identical on two consecutive animation frames.
async function clickWhenSettled(link: Locator) {
	await link.scrollIntoViewIfNeeded();
	await expect
		.poll(
			() =>
				link.evaluate(
					(el) =>
						new Promise<boolean>((resolve) => {
							const box = () => {
								const r = el.getBoundingClientRect();
								return [r.x, r.y, r.width, r.height].join(',');
							};
							const first = box();
							requestAnimationFrame(() => requestAnimationFrame(() => resolve(box() === first)));
						})
				),
			{ message: 'the link kept moving, so it never settled to click' }
		)
		.toBe(true);
	await link.click();
}

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'a visitor reaches the manifesto from the navigation through About, and it renders as an Editorial page',
	{ tag: ['@W1', '@CUR-3541'] },
	async ({ page }) => {
		const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
		expect(res?.status(), '/ did not load').toBe(200);

		const aboutLink = page.locator('header a[href="/about"]').first();
		await clickWhenSettled(aboutLink);
		await expect(page, 'the navigation About link did not open /about').toHaveURL(/\/about$/);

		const toManifesto = page.locator('main a[href="/about/manifesto"]').first();
		await expect(toManifesto, '/about has no link to the manifesto').toBeVisible();
		await clickWhenSettled(toManifesto);
		await expect(page, 'the About page link did not open the manifesto').toHaveURL(
			/\/about\/manifesto$/
		);

		const section = page.locator('[data-editorial]');
		await expect(section, 'the manifesto is not rendered by the Editorial template').toBeVisible();
		await expect(
			section.locator('[data-editorial-back]'),
			'the back link does not lead to the parent page'
		).toHaveAttribute('href', '/about');

		const title = section.locator('h1');
		await expect(title).toBeVisible();
		await expect(title).toHaveCSS('text-align', 'center');
		await expect(title).toHaveCSS('font-family', /Noto Serif/);

		const column = section.locator('.editorial-content');
		await expect(column, 'the page has no body column').toBeVisible();
		const firstParagraph = column.locator('p').filter({ hasText: /\S/ }).first();
		await expect(firstParagraph, 'the body column has no text').toBeVisible();
		await expect(firstParagraph).toHaveCSS('font-family', /Noto Serif/);
		await expect(column.locator('h2').first(), 'the body has no section heading').toBeVisible();

		// Images are lazy, so each is scrolled to and waited on before its box is read.
		const images = column.locator('figure img');
		const count = await images.count();
		expect(count, 'the body column holds no image').toBeGreaterThanOrEqual(2);
		for (let i = 0; i < count; i++) {
			const img = images.nth(i);
			await img.scrollIntoViewIfNeeded();
			await expect
				.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
					message: `image ${i + 1} in the body column never loaded`
				})
				.toBe(true);
		}

		const layout = await column.evaluate((el) => {
			const col = el.getBoundingClientRect();
			const imgs = [...el.querySelectorAll('figure img')].map((img) => {
				const r = img.getBoundingClientRect();
				return { left: r.left, right: r.right };
			});
			const blocks = [...el.children].filter(
				(c) => (c.textContent ?? '').trim() || c.querySelector('img')
			);
			const last = blocks.at(-1);
			return {
				col: { left: col.left, right: col.right },
				imgs,
				captions: [...el.querySelectorAll('figure figcaption')].map((c) =>
					(c.textContent ?? '').trim()
				),
				endsOnImage: Boolean(last && (last.matches('figure') || last.querySelector('img')))
			};
		});
		for (const [i, r] of layout.imgs.entries()) {
			expect(r.left, `image ${i + 1} starts left of the body column`).toBeGreaterThanOrEqual(
				layout.col.left - 1
			);
			expect(r.right, `image ${i + 1} runs past the body column`).toBeLessThanOrEqual(
				layout.col.right + 1
			);
		}
		expect(
			layout.captions.filter(Boolean).length,
			'no image in the body column carries a caption'
		).toBeGreaterThan(0);
		expect(layout.endsOnImage, 'the body column does not end on the signature image').toBe(true);
	}
);

// The signature closes the body column. Its desktop width is the design's 237px and a
// phone shows it 30% narrower, 166px. Each width is read off the loaded image at its own viewport.
async function signatureWidth(page: Page) {
	const res = await page.goto('/about/manifesto', { waitUntil: 'domcontentloaded' });
	expect(res?.status(), '/about/manifesto did not load').toBe(200);
	const signature = page.locator('[data-editorial] .editorial-content figure img').last();
	await signature.scrollIntoViewIfNeeded();
	await expect
		.poll(() => signature.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
			message: 'the signature image never loaded'
		})
		.toBe(true);
	return signature.evaluate((el) => el.getBoundingClientRect().width);
}

test.describe('manifesto signature at desktop width', () => {
	test.use({ viewport: { width: 1280, height: 800 } });
	// @prod-safe: it only loads the manifesto and measures one image, so the one-spec run can drive it on www.
	test(
		'keeps its 237px design width',
		{ tag: ['@W1', '@CUR-4250', '@prod-safe'] },
		async ({ page }) => {
			expect(await signatureWidth(page)).toBeCloseTo(237, 0);
		}
	);
});

test.describe('manifesto signature at phone width', () => {
	test.use({ viewport: { width: 375, height: 800 } });
	test(
		'is 30% narrower than on desktop, 166px',
		// @prod-safe: it only loads the manifesto and measures one image, so the one-spec run can drive it on www.
		{ tag: ['@W1', '@CUR-4250', '@prod-safe'] },
		async ({ page }) => {
			expect(await signatureWidth(page)).toBeCloseTo(166, 0);
		}
	);
});
