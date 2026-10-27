// e2e-product: @site
import { test, expect } from './helpers/test';

// The Logo carousel block credits the organisations a page builds on, each logo beside its
// label, in a row that runs off the right edge and scrolls. The methodology page carries it, though
// not in every environment's content: where it has none, the test records that nothing was checked
// rather than passing on an assertion it never made.

test.use({ viewport: { width: 1440, height: 900 } });

test(
	'the methodology page Logo carousel shows each loaded logo beside its label; the next chevron and a mouse drag scroll the row',
	{ tag: '@CUR-3965' },
	async ({ page }) => {
		await page.goto('/map/methodology', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('main')).toBeVisible();

		const section = page.locator('section[data-block="logoCarousel"]').first();
		if ((await section.count()) === 0) {
			test.info().annotations.push({
				type: 'no logo carousel block',
				description:
					"this environment's methodology page has no Logo carousel block, so nothing was checked"
			});
			return;
		}

		await section.scrollIntoViewIfNeeded();
		const slides = section.locator('[data-logo-carousel-slide]');
		await expect(slides.first()).toBeVisible();

		const count = await slides.count();
		for (let i = 0; i < count; i++) {
			const slide = slides.nth(i);
			const label = slide.locator('p');
			await expect(label, `logo ${i + 1} has no label`).not.toBeEmpty();
			const logo = slide.locator('img');
			await expect
				.poll(
					() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
					{ message: `logo ${i + 1} did not load` }
				)
				.toBe(true);
			const [logoBox, labelBox] = [await logo.boundingBox(), await label.boundingBox()];
			expect(labelBox!.x, `logo ${i + 1}'s label is not beside it`).toBeGreaterThan(
				logoBox!.x + logoBox!.width
			);
		}

		// A row that fits the screen has nothing to scroll, and shows no chevrons.
		const track = section.locator('[role="group"]');
		const overflows = await track.evaluate((el) => el.scrollWidth > el.clientWidth + 16);
		const next = section.getByRole('button', { name: 'Next logo' });
		if (!overflows) {
			await expect(next).toHaveCount(0);
			return;
		}
		await next.click();
		await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

		// Dragging right with the mouse brings the row back to its first logo.
		const box = (await track.boundingBox())!;
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + 300, y);
		await page.mouse.down();
		await page.mouse.move(box.x + 340, y, { steps: 4 });
		await page.mouse.move(box.x + 900, y, { steps: 10 });
		await page.mouse.up();
		await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBe(0);
	}
);
