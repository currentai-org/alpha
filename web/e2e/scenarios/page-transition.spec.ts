// e2e-product: @site
import { test, expect, type APIRequestContext, type Page } from './helpers/test';

// Page transitions ($lib/scroll/page-transition, CUR-4025): a link from one content page to another
// runs as a View Transition, with the old page fading out and the new one rising in under a header
// that holds still. The new page's snapshot is taken once ScrollSmoother has moved it to its own
// scroll position, so it rises in at the top (or, back and forward, where the reader left it) rather
// than at the old page's offset. Reduced motion and the chat app keep the hard cut.

const DESKTOP = { width: 1280, height: 800 };

type Recorded = {
	/** Each animation on a `::view-transition-*` pseudo-element, as `pseudo animation-name`. */
	animations: string[];
	/** As the new snapshot is taken: the window's scroll and `#smooth-content`'s translation. */
	scrollY: number;
	contentY: number;
	path: string;
	finished: boolean;
};

declare global {
	interface Window {
		__pageTransitions: Recorded[];
	}
}

/**
 * Records every View Transition the page starts. The call itself goes through unchanged, so the
 * transition runs exactly as it would for a reader.
 */
async function recordTransitions(page: Page) {
	await page.addInitScript(() => {
		window.__pageTransitions = [];
		const start = document.startViewTransition?.bind(document);
		if (!start) return;
		document.startViewTransition = ((
			arg: ViewTransitionUpdateCallback | StartViewTransitionOptions
		) => {
			const rec: Recorded = {
				animations: [],
				scrollY: NaN,
				contentY: NaN,
				path: '',
				finished: false
			};
			window.__pageTransitions.push(rec);
			const transition = start(arg);
			// `ready` resolves once the new snapshot is taken, before its first animation frame: the
			// page as it is now is the page the snapshot shows.
			void transition.ready.then(
				() => {
					const content = document.getElementById('smooth-content');
					rec.scrollY = window.scrollY;
					rec.contentY = content ? new DOMMatrix(getComputedStyle(content).transform).m42 : 0;
					rec.path = location.pathname;
					rec.animations = document
						.getAnimations()
						.map((a) => {
							const effect = a.effect as KeyframeEffect | null;
							const name = (a as CSSAnimation).animationName ?? '';
							return `${effect?.pseudoElement ?? ''} ${name}`;
						})
						.filter((s) => s.startsWith('::view-transition'));
				},
				() => {}
			);
			void transition.finished.finally(() => (rec.finished = true));
			return transition;
		}) as typeof document.startViewTransition;
	});
}

const transitions = (page: Page) => page.evaluate(() => window.__pageTransitions);

/**
 * The page has started `count` transitions in all, and every one has run to the end. A history
 * step resolves on the URL change, before SvelteKit's onNavigate starts the transition.
 */
async function transitionsDone(page: Page, count: number) {
	await expect
		.poll(
			async () => {
				const all = await transitions(page);
				return { started: all.length, finished: all.every((t) => t.finished) };
			},
			{ message: `page transition ${count} never started or never finished`, timeout: 5_000 }
		)
		.toEqual({ started: count, finished: true });
	return (await transitions(page)).at(-1)!;
}

/** How far `#smooth-content` sits from where the native scroll position puts it. */
const contentError = (page: Page) =>
	page.evaluate(() => {
		const content = document.getElementById('smooth-content')!;
		return Math.abs(new DOMMatrix(getComputedStyle(content).transform).m42 + window.scrollY);
	});

/** An update post from the sitemap: it always smooths, where a Payload page may not. */
async function updatePath(request: APIRequestContext): Promise<string> {
	const res = await request.get('/sitemap.xml');
	expect(res.ok(), 'the sitemap did not load').toBe(true);
	const path = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
		.map((m) => new URL(m[1]).pathname)
		.find((p) => /^\/updates\/[^/]+/.test(p));
	expect(path, 'the sitemap lists no update post').toBeTruthy();
	return path!;
}

/**
 * A real link click, the way a reader leaves a page; the caller waits for where it goes. The link
 * sits fixed in the app root, outside the smoothed content, so it is on screen however far the page
 * is scrolled.
 */
async function clickLink(page: Page, href: string) {
	// SvelteKit starts its router, which sets this, once the page has hydrated: a click before then
	// is a full page load, which no transition runs on.
	await page.waitForFunction(() => history.scrollRestoration === 'manual');
	await page.evaluate((href) => {
		document.getElementById('page-transition-test-link')?.remove();
		const a = document.createElement('a');
		a.href = href;
		a.textContent = 'page transition test link';
		a.id = 'page-transition-test-link';
		a.style.cssText =
			'position: fixed; left: 8px; bottom: 8px; z-index: 2147483647; background: #fff';
		document.getElementById('app')!.append(a);
	}, href);
	await page.locator('#page-transition-test-link').click();
}

async function clickThrough(page: Page, path: string) {
	await clickLink(page, path);
	await page.waitForURL((url) => url.pathname === path);
}

/**
 * Clicks through to `path` and waits until its page has rendered, which is after SvelteKit's
 * onNavigate: the URL alone changes before it.
 */
async function clickThroughAndRender(page: Page, path: string) {
	const before = await page.locator('main h1').first().textContent();
	await page.evaluate(() => document.documentElement.setAttribute('data-same-document', ''));
	await clickThrough(page, path);
	await expect(page.locator('main h1').first()).not.toHaveText(before ?? '');
	await expect(
		page.locator('html[data-same-document]'),
		'the click loaded a new document instead of navigating client-side'
	).toHaveCount(1);
}

/** Scrolls a smoothed page down, and waits for the content to catch up. */
async function scrollDown(page: Page, y: number) {
	await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
	await page.evaluate((y) => window.scrollTo(0, y), y);
	await expect.poll(() => contentError(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
	return page.evaluate(() => window.scrollY);
}

test.describe('page transitions, desktop', () => {
	test.use({ viewport: DESKTOP });

	test.beforeEach(async ({ page }) => recordTransitions(page));

	test('a link to another content page fades the old page out and raises the new one in, from the top, under a header that holds still', async ({
		page,
		request
	}) => {
		const next = await updatePath(request);
		await page.goto('/');
		expect(await scrollDown(page, 1200), 'the homepage is too short to scroll').toBeGreaterThan(
			400
		);

		await clickThrough(page, next);
		const t = await transitionsDone(page, 1);
		expect(t.animations).toEqual(
			expect.arrayContaining([
				'::view-transition-old(root) page-transition-out',
				'::view-transition-new(root) page-transition-in'
			])
		);
		// The header is its own group: it cross-fades in place, it doesn't fade out with the page.
		expect(t.animations.some((a) => a.startsWith('::view-transition-group(site-header)'))).toBe(
			true
		);
		expect(
			{ path: t.path, scrollY: t.scrollY, contentY: Math.round(t.contentY) },
			'the new page was captured before ScrollSmoother moved it to the top, so it rose in at the old page’s offset'
		).toEqual({ path: next, scrollY: 0, contentY: 0 });

		await expect(page.locator('html')).not.toHaveClass(/\bpage-transition\b/);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		expect(await contentError(page)).toBeLessThanOrEqual(1);
		await expect(page.locator('main h1').first()).toBeInViewport();
	});

	test('the header’s Home link transitions back too', async ({ page, request }) => {
		await page.goto(await updatePath(request));
		await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
		await page.locator('[data-site-header] a[aria-label="Home"]').click();
		await page.waitForURL((url) => url.pathname === '/');
		const t = await transitionsDone(page, 1);
		expect(t.path).toBe('/');
		expect(t.animations).toContain('::view-transition-new(root) page-transition-in');
	});

	test('back and forward transition too, and each page comes back at the scroll position the reader left it at', async ({
		page,
		request
	}) => {
		const next = await updatePath(request);
		await page.goto('/');
		const homeY = await scrollDown(page, 1200);
		await clickThrough(page, next);
		await transitionsDone(page, 1);
		const nextY = await scrollDown(page, 600);

		await page.goBack();
		await page.waitForURL((url) => url.pathname === '/');
		let t = await transitionsDone(page, 2);
		expect(t.path).toBe('/');
		expect(t.animations).toContain('::view-transition-new(root) page-transition-in');
		expect(
			Math.abs(t.contentY + homeY),
			'back: the homepage was captured before ScrollSmoother restored its scroll position'
		).toBeLessThanOrEqual(2);
		expect(await page.evaluate(() => window.scrollY)).toBe(homeY);
		await expect.poll(() => contentError(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);

		await page.goForward();
		await page.waitForURL((url) => url.pathname === next);
		t = await transitionsDone(page, 3);
		expect(t.path).toBe(next);
		expect(await page.evaluate(() => window.scrollY)).toBe(nextY);
		await expect.poll(() => contentError(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
	});

	test('back from a smoothed page onto a natively scrolled one leaves no smoothed body height behind', async ({
		page,
		request
	}) => {
		await page.goto('/roadmap-v2');
		await expect(page.locator('html')).not.toHaveClass(/\bscroll-smoothed\b/);
		await clickThrough(page, await updatePath(request));
		await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
		await transitionsDone(page, 1);

		await page.goBack();
		await page.waitForURL((url) => url.pathname === '/roadmap-v2');
		await transitionsDone(page, 2);
		await expect(page.locator('html')).not.toHaveClass(/\bscroll-smoothed\b/);
		expect(
			await page.evaluate(() => document.body.style.height),
			'the body kept a height from the smoothed page, or from lifting it for the scroll restore'
		).toBe('');
	});

	test('the loading bar shows only for a navigation still loading after 200ms, and the page transitions in once it has loaded', async ({
		page,
		request
	}) => {
		const next = await updatePath(request);
		await page.goto('/');
		await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
		// Hold the next page's data back, so the navigation is a slow one.
		await page.route('**/__data.json**', async (route) => {
			await new Promise((r) => setTimeout(r, 1_500));
			await route.continue();
		});
		await page.evaluate(() => {
			const w = window as unknown as { clickAt?: number; barAt?: number };
			// eslint-disable-next-line svelte/no-add-event-listener -- runs in the page, outside any component
			document.addEventListener('click', () => (w.clickAt ??= performance.now()), true);
			new MutationObserver(() => {
				if (document.querySelector('[role="progressbar"][aria-label="Loading page"]')) {
					w.barAt ??= performance.now();
				}
			}).observe(document.body, { childList: true, subtree: true });
		});

		await clickThrough(page, next);
		await transitionsDone(page, 1);
		const { clickAt, barAt } = await page.evaluate(() => {
			const w = window as unknown as { clickAt?: number; barAt?: number };
			return { clickAt: w.clickAt, barAt: w.barAt };
		});
		expect(barAt, 'the loading bar never showed during a 1.5s load').toBeDefined();
		const delay = barAt! - clickAt!;
		expect(delay, 'the loading bar showed at once, ahead of its delay').toBeGreaterThanOrEqual(190);
		expect(delay, 'the loading bar waited for the load to end').toBeLessThan(1_000);
		await expect(page.locator('[role="progressbar"][aria-label="Loading page"]')).toHaveCount(0);
	});

	test('a same-page #anchor link scrolls without a page transition', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
		const id = await page.evaluate(() => document.querySelector('main section[id]')?.id ?? null);
		expect(id, 'the homepage has no anchored section').toBeTruthy();
		await clickLink(page, `/#${id}`);
		await expect(page).toHaveURL(new RegExp(`#${id}$`));
		// A `#…` link loads nothing: SvelteKit's onNavigate has run by the end of the next frame.
		await page.evaluate(
			() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
		);
		expect(await transitions(page)).toEqual([]);
	});

	test('leaving for the chat app keeps the hard cut', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('html')).toHaveClass(/\bscroll-smoothed\b/);
		await clickLink(page, '/chat');
		await page.waitForURL((url) => url.pathname.startsWith('/chat'));
		await expect(page.locator('[data-site-header]')).toHaveCount(0);
		expect(await transitions(page)).toEqual([]);
	});
});

test.describe('page transitions, reduced motion', () => {
	test.use({ viewport: DESKTOP, reducedMotion: 'reduce' });

	test('a reader who asks for reduced motion gets the hard cut, with no transition animation', async ({
		page,
		request
	}) => {
		await recordTransitions(page);
		const next = await updatePath(request);
		await page.goto('/');
		await clickThroughAndRender(page, next);
		expect(await transitions(page)).toEqual([]);
		await expect(page.locator('html')).not.toHaveClass(/\bpage-transition\b/);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
	});
});
