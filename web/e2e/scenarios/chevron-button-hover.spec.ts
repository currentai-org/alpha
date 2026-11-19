// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';
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

type ContrastSample = { ms: number; fill: string; chevron: string; ratio: number };

/**
 * Reads the icon box's fill and the chevron's colour on every animation frame for `ms`, and the
 * WCAG contrast ratio between them. Started before the pointer moves, so the frames span the whole
 * hover transition rather than only its end.
 */
function sampleIconContrast(iconBox: Locator, ms: number) {
	return iconBox.evaluate(
		(box, ms) =>
			new Promise<ContrastSample[]>((resolve) => {
				const svg = box.querySelector('svg')!;
				const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
				const lum = (c: string) => {
					const [r, g, b] = rgb(c).map((v) => {
						const s = v / 255;
						return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * r + 0.7152 * g + 0.0722 * b;
				};
				const out: ContrastSample[] = [];
				const start = performance.now();
				const frame = () => {
					const t = Math.round(performance.now() - start);
					const fill = getComputedStyle(box).backgroundColor;
					const chevron = getComputedStyle(svg).color;
					const [hi, lo] = [lum(fill), lum(chevron)].sort((a, b) => b - a);
					out.push({ ms: t, fill, chevron, ratio: (hi + 0.05) / (lo + 0.05) });
					if (t < ms) requestAnimationFrame(frame);
					else resolve(out);
				};
				requestAnimationFrame(frame);
			}),
		ms
	);
}

// WCAG 1.4.11's floor for a graphic against what sits next to it. The settled states clear it
// easily (salmon on dark blue is about 6:1, white on dark blue about 14:1); a fill and chevron that
// cross-fade through each other drop to about 1.6:1 halfway.
const CONTRAST_FLOOR = 3;

test(
	'hovering in and out of a footer chevron button never drops the chevron below 3:1 against its icon box',
	{ tag: '@CUR-4031' },
	async ({ page }) => {
		await page.goto('/');
		const button = page.locator('footer .site-footer-intro [data-slot="button"]').first();
		await expect(button, 'the footer has no chevron button').toBeAttached();
		await smoothed(page);
		await scrollFooterToRest(page, button);
		const iconBox = button.locator(':scope > span').last();
		await expect(iconBox.locator('svg'), 'the icon box has no chevron').toBeAttached();

		const box = (await button.boundingBox())!;
		const away = { x: box.x + box.width / 2, y: Math.max(0, box.y - 60) };
		await page.mouse.move(away.x, away.y);

		// Both directions: a cross-fade passes its midpoint on the way in and again on the way out.
		for (const [direction, target, settled] of [
			['hover in', { x: box.x + box.width / 2, y: box.y + box.height / 2 }, SALMON],
			['hover out', away, DARK_BLUE]
		] as const) {
			const sampling = sampleIconContrast(iconBox, 600);
			await page.mouse.move(target.x, target.y);
			const samples = await sampling;
			expect(samples.length, `${direction}: too few frames sampled`).toBeGreaterThan(10);
			expect(samples.at(-1)!.fill, `${direction}: the icon box never changed colour`).toBe(settled);
			const worst = samples.reduce((a, b) => (b.ratio < a.ratio ? b : a));
			expect(
				worst.ratio,
				`${direction}: the chevron lost contrast against its icon box at ${worst.ms} ms ` +
					`(fill ${worst.fill}, chevron ${worst.chevron})`
			).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
		}
	}
);
