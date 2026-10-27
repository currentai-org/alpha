// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';

// The "Join us" cards on the homepage (Cards block) and the paths on /contribute
// (Contribute Paths block) play a Lottie over their image when "Lottie Animation" is on in the CMS.
// The image is the animation's last frame, so the Lottie lands on the image's exact box; it plays
// once when scrolled into view, and hovering the card replays it. Reduced motion keeps the image and
// never fetches the file.
//
// Which items have a Lottie set is CMS content, which a spec cannot choose. Each test reads it from
// the page (`data-feature-lottie`, set only when a Lottie is configured) and, when none is, asserts
// the plain-image contract instead and annotates that the Lottie path was not exercised. Only items
// with an image are read: a Lottie without one has no image to stand in for.

const SURFACES = [
	{ name: 'homepage Join us cards', item: '[data-card]', start: '/' },
	{ name: '/contribute paths', item: '[data-path]', start: '/contribute' }
] as const;

const artIn = (item: Locator) => item.locator('[data-feature-art][data-feature-lottie]');

/** The items on the page with a Lottie over an image, or none (annotated). */
async function lottieItems(page: Page, selector: string, where: string): Promise<Locator[]> {
	const items = page
		.locator(selector)
		.filter({ has: page.locator('[data-feature-lottie] img.feature-art-static') });
	const count = await items.count();
	if (count === 0)
		test.info().annotations.push({
			type: 'lottie-not-configured',
			description: `No ${where} item has a Lottie set in this environment's CMS, so only the plain-image contract was checked.`
		});
	return Array.from({ length: count }, (_, i) => items.nth(i));
}

/** The player's SVG markup: lottie-web rewrites transforms and opacities on every frame it draws. */
const frameOf = (art: Locator) =>
	art.locator('[data-feature-animation] svg').evaluate((svg) => svg.innerHTML);

test.use({ viewport: { width: 1280, height: 800 } });

test(
	'a visitor reaches the contribute paths from the homepage Join us cards',
	{ tag: '@CUR-4257' },
	async ({ page }) => {
		await page.goto('/');
		const card = page.locator('[data-card]').filter({ has: page.locator('a[href="/contribute"]') });
		await expect(card.first(), 'no homepage card links to /contribute').toBeVisible();
		await card.first().locator('a[href="/contribute"]').first().click();
		await expect(page).toHaveURL(/\/contribute$/);
		await expect(page.locator('[data-path]').first()).toBeVisible();
	}
);

for (const { name, item, start } of SURFACES) {
	test(
		`each ${name} Lottie plays over its image's exact box once scrolled into view`,
		{ tag: '@CUR-4257' },
		async ({ page }) => {
			await page.goto(start);
			const items = await lottieItems(page, item, name);
			if (items.length === 0) {
				await expect(page.locator(`${item} img`).first()).toBeVisible();
				await expect(page.locator(`${item} [data-feature-animation]`)).toHaveCount(0);
				return;
			}
			for (const it of items) {
				const art = artIn(it);
				await art.scrollIntoViewIfNeeded();
				await expect(art, 'the Lottie never started; the static image stayed').toHaveAttribute(
					'data-feature-art',
					'animated',
					{ timeout: 15_000 }
				);
				const player = art.locator('[data-feature-animation="playing"]');
				await expect(player.locator('svg g').first()).toBeAttached();
				const img = art.locator('img.feature-art-static');
				expect(await img.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
				// Both boxes in one synchronous read: the item rises into place (revealStagger's 28px
				// translateY) just as the Lottie starts, and two separate reads straddle that frame.
				const { box, image } = await player.evaluate((el, imgSelector) => {
					const rect = (e: Element) => {
						const { x, y, width, height } = e.getBoundingClientRect();
						return { x, y, width, height };
					};
					return {
						box: rect(el),
						image: rect(el.closest('[data-feature-art]')!.querySelector(imgSelector)!)
					};
				}, 'img.feature-art-static');
				for (const k of ['x', 'y', 'width', 'height'] as const)
					expect(
						Math.abs(box[k] - image[k]),
						`the Lottie's ${k} differs from the image's`
					).toBeLessThan(1);
			}
		}
	);

	test(
		`hovering a ${name} item replays its Lottie, which ends on the same frame`,
		{ tag: '@CUR-4257' },
		async ({ page }) => {
			await page.goto(start);
			const [first] = await lottieItems(page, item, name);
			if (!first) return;
			const art = artIn(first);
			await art.scrollIntoViewIfNeeded();
			await expect(art).toHaveAttribute('data-feature-art', 'animated', { timeout: 15_000 });
			// Every Join us animation is under 1.2 s and plays once: wait until it stops changing.
			let last = '';
			await expect
				.poll(
					async () => {
						const now = await frameOf(art);
						const settled = now === last;
						last = now;
						return settled;
					},
					{ intervals: [500], timeout: 10_000 }
				)
				.toBe(true);
			const ended = last;

			await page.mouse.move(0, 0);
			await first.hover();
			await expect
				.poll(() => frameOf(art), { message: 'hovering did not replay the Lottie', timeout: 2_000 })
				.not.toBe(ended);
			await expect
				.poll(() => frameOf(art), { message: 'the replay did not end on the last frame' })
				.toBe(ended);
		}
	);

	test(
		`with reduced motion the ${name} keep their images and never fetch a Lottie`,
		{ tag: '@CUR-4257' },
		async ({ page }) => {
			await page.emulateMedia({ reducedMotion: 'reduce' });
			const fetched: string[] = [];
			page.on('request', (r) => {
				if (new URL(r.url()).pathname.startsWith('/api/lottie/')) fetched.push(r.url());
			});
			await page.goto(start);
			const items = await lottieItems(page, item, name);
			const srcs: string[] = [];
			for (const it of items) {
				const art = artIn(it);
				await art.scrollIntoViewIfNeeded();
				await expect(art).toHaveAttribute('data-feature-art', 'static');
				await expect(art.locator('img')).toBeVisible();
				await expect(art.locator('[data-feature-animation]')).toHaveCount(0);
				srcs.push((await art.getAttribute('data-feature-lottie'))!);
			}
			await page.waitForLoadState('networkidle');
			const theirs = fetched.filter((url) => srcs.some((src) => url.endsWith(src)));
			expect(theirs, 'a Lottie was fetched under reduced motion').toEqual([]);
		}
	);
}
