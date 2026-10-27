// e2e-product: @site
import { test, expect, devices, type APIRequestContext, type Page } from './helpers/test';

// Every Payload block on a content page fades up into place as it scrolls into view
// ($lib/actions/revealStagger, the hidden start state in app.css keyed on `data-reveal-stagger`).
// The reveal sits on a block's inner content, never on the block itself, which ScrollSmoother's lag
// moves with a transform of its own. Under reduced motion and without JavaScript every block simply
// shows; on a phone, where ScrollSmoother stays off, blocks still reveal on the native scroll.

const DESKTOP = { width: 1280, height: 800 };
const PAGES_TO_TRY = 8;
// Blocks that don't reveal: anchor-sections holds a pinned nav and scroll spies a moving parent
// would mis-measure, and notebooks is a tool on a page of its own.
const NO_REVEAL = new Set(['anchor-sections', 'notebooks']);
// Blocks whose heading and each item reveal on their own, staggered, rather than the block's
// content as one, with the selector for an item in each.
const PER_ITEM: Record<string, string> = {
	cards: '[data-card]',
	faqs: 'details',
	quotes: '[data-quotes-slide]',
	logoCarousel: '[data-logo-carousel-slide]',
	cardCarousel: '[data-card-carousel-slide]',
	'epic-listing': '[data-epic]',
	'contribute-paths': 'article[data-path]',
	features: '[data-feature-item], [data-feature-icon-item]',
	partners: '[data-partner-item]',
	'latest-progress': 'ul > li'
};

/** Every reveal target in the page's content blocks, with its block's name and current state. */
const targets = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('[data-content-blocks] [data-reveal-stagger]')].map(
			(el) => {
				const root = el.closest('[data-content-blocks] > *')!;
				const style = getComputedStyle(el);
				return {
					block:
						(root.closest('[data-block]') ?? root.querySelector('[data-block]'))?.getAttribute(
							'data-block'
						) ?? '?',
					opacity: Number(style.opacity),
					transform: style.transform,
					revealed: el.hasAttribute('data-revealed')
				};
			}
		)
	);

/** The blocks on the page that should reveal but hold no reveal target. */
const unwired = (page: Page, noReveal: string[]) =>
	page.evaluate(
		(noReveal) =>
			[...document.querySelectorAll<HTMLElement>('[data-content-blocks] > *')]
				.map((root) => ({
					name:
						(root.matches('[data-block]')
							? root
							: root.querySelector('[data-block]')
						)?.getAttribute('data-block') ?? root.tagName.toLowerCase(),
					wired: !!root.querySelector('[data-reveal-stagger]')
				}))
				.filter((b) => !b.wired && !noReveal.includes(b.name))
				.map((b) => b.name),
		noReveal
	);

/**
 * Items in the per-item blocks that don't reveal on their own: an item with no reveal around it, or
 * one whose reveal also holds another item, so the two fade as one.
 */
const revealShape = (page: Page, perItem: Record<string, string>) =>
	page.evaluate((perItem) => {
		const joined: string[] = [];
		for (const root of document.querySelectorAll('[data-content-blocks] > *')) {
			const named = root.matches('[data-block]') ? root : root.querySelector('[data-block]');
			const name = named?.getAttribute('data-block') ?? '';
			const selector = perItem[name];
			if (!selector) continue;
			const items = [...root.querySelectorAll(selector)];
			const whole = items.filter((item) => {
				const target = item.closest('[data-reveal-stagger]');
				return !target || target.querySelectorAll(selector).length + +target.matches(selector) > 1;
			});
			if (whole.length) joined.push(`${name}: ${whole.length} of ${items.length} items`);
		}
		return { whole: joined };
	}, perItem);

/**
 * Scrolls the window to the bottom a step at a time, the way a reader works down the page: `share`
 * of the window every 150ms.
 */
async function scrollThrough(page: Page, share = 0.6) {
	const height = await page.evaluate(() => window.innerHeight);
	for (;;) {
		const done = await page.evaluate((step) => {
			const max = document.documentElement.scrollHeight - window.innerHeight;
			window.scrollTo(0, Math.min(max, window.scrollY + step));
			return window.scrollY >= max - 1;
		}, height * share);
		await page.waitForTimeout(150);
		if (done) break;
	}
}

/**
 * Starts recording, for every block reveal still to come, where the block's first piece of content
 * (a heading, text, an image or a link) sits at the moment its fade starts. `lateFades` reads back
 * the ones whose content was still below the window, so the fade played out unseen.
 */
const watchFadeStarts = (page: Page) =>
	page.evaluate(() => {
		const late: string[] = [];
		(window as unknown as { __lateFades: string[] }).__lateFades = late;
		const pending = [
			...document.querySelectorAll<HTMLElement>('[data-content-blocks] [data-reveal-stagger]')
		].filter((el) => !el.hasAttribute('data-revealed'));
		const observer = new MutationObserver((records) => {
			for (const { target } of records) {
				const el = target as HTMLElement;
				if (!el.hasAttribute('data-revealed')) continue;
				const content = el.querySelector('h1, h2, h3, p, img, a, li') ?? el;
				const top = content.getBoundingClientRect().top;
				if (top >= window.innerHeight) {
					const block = el.closest('[data-content-blocks] > *')!;
					const name =
						(block.matches('[data-block]')
							? block
							: block.querySelector('[data-block]')
						)?.getAttribute('data-block') ?? '?';
					late.push(`${name}: content ${Math.round(top - window.innerHeight)}px below the window`);
				}
			}
		});
		for (const el of pending)
			observer.observe(el, { attributes: true, attributeFilter: ['data-revealed'] });
	});

const lateFades = (page: Page) =>
	page.evaluate(() => (window as unknown as { __lateFades: string[] }).__lateFades);

/** Content pages from the sitemap, as paths on this deployment, the homepage first. */
async function contentPaths(request: APIRequestContext): Promise<string[]> {
	const res = await request.get('/sitemap.xml');
	expect(res.ok(), 'the sitemap did not load').toBe(true);
	const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	const paths = locs
		.map((loc) => new URL(loc).pathname)
		.filter((p) => p !== '/' && !/^\/(product|org|updates)\//.test(p));
	return ['/', ...paths].slice(0, PAGES_TO_TRY);
}

/** Every reveal target on the page ends up shown, in place, and marked revealed. */
async function expectAllRevealed(page: Page, path: string) {
	await expect
		.poll(
			async () =>
				(await targets(page))
					.filter((t) => !t.revealed || t.opacity !== 1 || t.transform !== 'none')
					.map((t) => `${t.block} (opacity ${t.opacity}, ${t.transform})`),
			{ message: `${path}: some blocks never finished revealing`, timeout: 5_000 }
		)
		.toEqual([]);
}

test.describe('block reveal, desktop', () => {
	test.use({ viewport: DESKTOP });

	test(
		'content blocks below the fold start hidden and fade up into place as the page scrolls to them, while ScrollSmoother lags the blocks',
		{ tag: '@CUR-4023' },
		async ({ page, request }) => {
			test.setTimeout(180_000);
			const seen = new Set<string>();
			for (const path of await contentPaths(request)) {
				await page.goto(path);
				const smooths = await page
					.locator('html.scroll-smoothed')
					.waitFor({ timeout: 5_000 })
					.then(
						() => true,
						() => false
					);
				if (!smooths) continue;

				expect(await unwired(page, [...NO_REVEAL]), `${path}: blocks with no reveal`).toEqual([]);
				const shape = await revealShape(page, PER_ITEM);
				expect(shape.whole, `${path}: items that don't reveal one by one`).toEqual([]);

				// A target whose top sits well below the window can't have been reached yet.
				const below = await page.evaluate(() =>
					[...document.querySelectorAll<HTMLElement>('[data-content-blocks] [data-reveal-stagger]')]
						.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 1.5)
						.map((el) => Number(getComputedStyle(el).opacity))
				);
				expect(
					below.filter((opacity) => opacity !== 0),
					`${path}: content far below the fold was showing before the page scrolled to it`
				).toEqual([]);

				await scrollThrough(page);
				await expectAllRevealed(page, path);
				for (const t of await targets(page)) seen.add(t.block);
			}
			expect(
				seen.size,
				`only ${[...seen].join(', ') || 'no'} blocks revealed across the pages tried`
			).toBeGreaterThanOrEqual(3);
		}
	);

	test(
		"a block's fade starts with its content already in the window, not while it is still below it",
		{ tag: '@CUR-4023' },
		async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
			await watchFadeStarts(page);
			await scrollThrough(page, 0.25);
			await expectAllRevealed(page, '/');
			expect(await lateFades(page)).toEqual([]);
		}
	);

	test(
		'content already in the window when the page opens shows without a scroll',
		{ tag: '@CUR-4023' },
		async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
			await expect
				.poll(
					() =>
						page.evaluate(
							() =>
								[
									...document.querySelectorAll<HTMLElement>(
										'[data-content-blocks] [data-reveal-stagger]'
									)
								]
									.filter((el) => el.getBoundingClientRect().top < window.innerHeight * 0.85)
									.filter((el) => getComputedStyle(el).opacity !== '1').length
						),
					{ message: 'content in the first window stayed hidden', timeout: 5_000 }
				)
				.toBe(0);
		}
	);
});

test.describe('block reveal, reduced motion', () => {
	test.use({ viewport: DESKTOP, reducedMotion: 'reduce' });

	test(
		'under reduced motion every block shows at once, with nothing hidden or moved',
		{ tag: '@CUR-4023' },
		async ({ page }) => {
			await page.goto('/');
			const all = await targets(page);
			expect(all.length, 'the homepage has no reveal targets to check').toBeGreaterThan(0);
			expect(all.filter((t) => t.opacity !== 1 || t.transform !== 'none')).toEqual([]);
		}
	);
});

test.describe('block reveal, no JavaScript', () => {
	test.use({ viewport: DESKTOP, javaScriptEnabled: false });

	test(
		'without JavaScript every block shows, with nothing hidden or moved',
		{ tag: '@CUR-4023' },
		async ({ page }) => {
			await page.goto('/');
			const all = await targets(page);
			expect(all.length, 'the homepage has no reveal targets to check').toBeGreaterThan(0);
			expect(all.filter((t) => t.opacity !== 1 || t.transform !== 'none')).toEqual([]);
		}
	);
});

// A filled animation that ends on `transform: none` reports the identity matrix, not `none`.
const UNMOVED = ['none', 'matrix(1, 0, 0, 1, 0, 0)'];

test.describe('block reveal, script never runs', () => {
	test.use({ viewport: DESKTOP });

	test(
		"when the app's script fails to load, every block still shows within a few seconds rather than staying hidden",
		{ tag: '@CUR-4075' },
		async ({ page }) => {
			// Scripting is on, so app.css hides the blocks, but nothing that would lift them arrives. Only
			// the scripts: the stylesheets share the directory, and without them nothing is hidden.
			await page.route(/\/_app\/immutable\/.*\.js(\?|$)/, (route) => route.abort());
			await page.goto('/');
			await expect
				.poll(async () => (await targets(page)).length, {
					message: 'the homepage has no reveal targets to check'
				})
				.toBeGreaterThan(0);
			await expect
				.poll(
					async () =>
						(await targets(page))
							.filter((t) => t.opacity !== 1 || !UNMOVED.includes(t.transform))
							.map((t) => `${t.block} (opacity ${t.opacity}, ${t.transform})`),
					{ message: 'blocks stayed hidden with no script to reveal them', timeout: 5_000 }
				)
				.toEqual([]);
		}
	);
});

test.describe('block reveal, touch', () => {
	const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
	test.use(pixel);

	test(
		'on a phone, with native scrolling, blocks below the fold start hidden and reveal as the page scrolls to them',
		{ tag: '@CUR-4023' },
		async ({ page }) => {
			await page.goto('/');
			await expect(page.locator('html')).not.toHaveClass(/\bscroll-smoothed\b/);
			const before = await page.evaluate(() =>
				[...document.querySelectorAll<HTMLElement>('[data-content-blocks] [data-reveal-stagger]')]
					.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 1.5)
					.map((el) => Number(getComputedStyle(el).opacity))
			);
			expect(
				before.length,
				'nothing on the homepage sits below the fold to reveal'
			).toBeGreaterThan(0);
			expect(before.filter((opacity) => opacity !== 0)).toEqual([]);
			await watchFadeStarts(page);
			await scrollThrough(page, 0.25);
			await expectAllRevealed(page, '/');
			expect(await lateFades(page), 'a fade started with its content below the window').toEqual([]);
		}
	);
});
