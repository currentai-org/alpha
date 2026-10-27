// e2e-product: @site
import { test, expect, type Page } from './helpers/test';
import { scrollFooterToRest } from './helpers/footer';

// Hovering a chevron button (the footer's salmon ones here) fills the label side with the
// three-column wipe and swaps the icon box to the button's own colours. When ScrollSmoother leaves the
// button between device pixels, whatever lies under the icon box's antialiased edge shows as a 1px
// line: the wipe if it runs under the box, the page if the button's background stops at the padding
// edge. Headless Chromium doesn't composite that hairline, so a pixel check here stays green either
// way; the first test asserts the two conditions that keep it out of the button, the second that
// ScrollSmoother never leaves the page, its lagged blocks or the footer between pixels.

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

const DARK_BLUE = 'rgb(20, 46, 62)';
const SALMON = 'rgb(242, 145, 134)';

/**
 * Waits until ScrollSmoother runs and glides. It loads after the page, and starting puts the page back
 * at its own scroll position, so a scroll before then is undone; for its first 0.5s it jumps instead
 * of gliding (`startupPhase`, a fixed delayedCall in ScrollSmoother.js), as smooth-scroll.spec.ts
 * waits out too.
 */
async function smoothed(page: Page) {
	await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
	await page.waitForTimeout(600);
}

test(
	'hovering a footer chevron button fills the label side only and swaps the icon box to salmon',
	{ tag: '@CUR-4031' },
	async ({ page }) => {
		await page.goto('/');
		const button = page.locator('footer .site-footer-intro [data-slot="button"]').first();
		await expect(button, 'the footer has no chevron button').toBeAttached();
		await smoothed(page);
		// Scrolled to the bottom, where the footer sits, rather than with scrollIntoViewIfNeeded(), and
		// hovered once the button has held still on screen (helpers/footer.ts).
		await scrollFooterToRest(page, button);
		const iconBox = button.locator(':scope > span').last();
		const columns = button.locator('span[aria-hidden="true"] > span');
		await expect(columns, 'the button has no wipe columns').toHaveCount(3);

		await expect(
			button,
			"the button's background stops at its padding edge, leaving the page to show through the border's inner edge"
		).toHaveCSS('background-clip', 'border-box');
		await expect(iconBox).toHaveCSS('background-color', DARK_BLUE);

		await button.hover();
		const geometry = () =>
			button.evaluate((el) => {
				const box = (el.lastElementChild as HTMLElement).getBoundingClientRect();
				const border = parseFloat(getComputedStyle(el.lastElementChild!).borderLeftWidth);
				const wipe = el.querySelector('span[aria-hidden="true"]')!.getBoundingClientRect();
				const cols = [...el.querySelectorAll('span[aria-hidden="true"] > span')];
				return {
					filled: cols.every((c) => c.getBoundingClientRect().height >= el.clientHeight),
					// How far the wipe reaches past the icon box's own border, into what its fill covers.
					underBox: wipe.right - (box.left + border)
				};
			});
		await expect
			.poll(async () => (await geometry()).filled, { message: 'the wipe never filled the label' })
			.toBe(true);
		expect(
			(await geometry()).underBox,
			'the wipe runs under the icon box, where its edge shows through as a hairline'
		).toBeLessThanOrEqual(0.5);
		await expect(iconBox).toHaveCSS('background-color', SALMON);
		await expect(iconBox).toHaveCSS('color', DARK_BLUE);
	}
);

type Glide = {
	/** How far `#smooth-content` trailed the native scroll position, at most. */
	maxTrail: number;
	/** The largest offset a lagged block or the footer carried of its own. */
	maxLag: number;
	/** Frames where `#smooth-content` sat at a fractional offset, as `<ms>: <y>`. */
	contentOff: string[];
	/** Frames where a lagged block or the footer sat at a fractional offset, as `<ms> <el>: <y>`. */
	laggedOff: string[];
};

/** Scrolls to the bottom and reads every animation frame for `ms`. */
function glide(page: Page, ms: number) {
	return page.evaluate(
		(ms) =>
			new Promise<Glide>((resolve) => {
				const content = document.getElementById('smooth-content')!;
				const lagged = [
					...document.querySelectorAll<HTMLElement>(
						'[data-content-blocks] > *, [data-smooth-footer]'
					)
				];
				const y = (el: Element) => new DOMMatrix(getComputedStyle(el).transform).m42;
				const whole = (v: number) => Math.abs(v - Math.round(v)) < 0.001;
				const name = (el: Element, i: number) =>
					el.matches('[data-smooth-footer]') ? 'footer' : `block ${i}`;
				const out: Glide = { maxTrail: 0, maxLag: 0, contentOff: [], laggedOff: [] };
				const start = performance.now();
				window.scrollTo(0, document.documentElement.scrollHeight);
				const frame = () => {
					const t = Math.round(performance.now() - start);
					const c = y(content);
					out.maxTrail = Math.max(out.maxTrail, Math.abs(c + window.scrollY));
					if (!whole(c)) out.contentOff.push(`${t}: ${c}`);
					lagged.forEach((el, i) => {
						const v = y(el);
						out.maxLag = Math.max(out.maxLag, Math.abs(v));
						if (!whole(v)) out.laggedOff.push(`${t} ${name(el, i)}: ${v}`);
					});
					if (t < ms) requestAnimationFrame(frame);
					else resolve(out);
				};
				requestAnimationFrame(frame);
			}),
		ms
	);
}

test(
	'while the page glides, the content, its lagged blocks and the footer only ever sit on whole pixels',
	{ tag: '@CUR-4031' },
	async ({ page }) => {
		await page.goto('/');
		await smoothed(page);

		const result = await glide(page, 1_500);
		expect(result.maxTrail, 'the content jumped instead of gliding').toBeGreaterThan(50);
		expect(result.maxLag, 'no block or footer lagged behind the scroll').toBeGreaterThan(1);
		expect
			.soft(
				result.contentOff.slice(0, 5),
				"#smooth-content sat between pixels (ScrollSmoother's `wholePixels`)"
			)
			.toEqual([]);
		expect
			.soft(
				result.laggedOff.slice(0, 5),
				'a lagged block or the footer sat between pixels (roundLagged in smooth-scroll.ts)'
			)
			.toEqual([]);
	}
);
