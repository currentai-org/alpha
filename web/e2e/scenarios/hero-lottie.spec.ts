// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// A hero with "Lottie Animation" on in the CMS plays its Lottie JSON over the hero
// image's box, the image stepping aside once it starts. The image stays the fallback: reduced motion
// never loads the animation, and a file that fails to load leaves the image showing.
//
// Whether the homepage has a Lottie set is CMS content, which a spec cannot choose. Each test reads
// it from the page (`data-hero-lottie`, set only when a Lottie is configured) and, when none is,
// asserts the plain-image contract instead and annotates that the Lottie path was not exercised.

const wrapper = (page: Page) => page.locator('[data-hero-art]');
const staticImage = (page: Page) => page.locator('[data-hero-art] img.hero-art-static');
const opacityOf = (page: Page) =>
	staticImage(page).evaluate((img) => getComputedStyle(img).opacity);

/** The configured Lottie's URL, or null (annotated) when the homepage has none. */
async function lottieSrc(page: Page): Promise<string | null> {
	const src = await wrapper(page).getAttribute('data-hero-lottie');
	if (!src)
		test.info().annotations.push({
			type: 'lottie-not-configured',
			description:
				"The homepage hero has no Lottie set in this environment's CMS, so only the plain-image contract was checked."
		});
	return src;
}

for (const { name, width, height, overflows } of [
	{ name: 'on a phone', width: 390, height: 844, overflows: true },
	{ name: 'on desktop', width: 1280, height: 800, overflows: false }
]) {
	test.describe(name, () => {
		test.use({ viewport: { width, height } });

		test(
			`the hero Lottie plays over the image's exact box and the image steps aside, ${name}`,
			{ tag: '@CUR-2977' },
			async ({ page }) => {
				await page.goto('/');
				await expect(staticImage(page)).toBeVisible();
				if (!(await lottieSrc(page))) {
					await expect(wrapper(page)).toHaveAttribute('data-hero-art', 'static');
					expect(await opacityOf(page)).toBe('1');
					return;
				}
				const player = page.locator('[data-hero-animation="playing"]');
				await expect(player, 'the Lottie never started; the static image stayed').toBeVisible({
					timeout: 15_000
				});
				await expect(wrapper(page)).toHaveAttribute('data-hero-art', 'animated');
				// lottie-web drew its SVG, with content, into the player.
				await expect(player.locator('svg g').first()).toBeAttached();
				expect(await opacityOf(page), 'the static image still shows under the Lottie').toBe('0');

				const [art, img] = await Promise.all([
					player.boundingBox(),
					staticImage(page).boundingBox()
				]);
				for (const k of ['x', 'y', 'width', 'height'] as const)
					expect(
						Math.abs(art![k] - img![k]),
						`the Lottie's ${k} differs from the image's`
					).toBeLessThan(1);
				// On a phone the image is wider than the screen and runs off its right edge; the
				// animation follows it there rather than shrinking to fit.
				expect(art!.x + art!.width > width, 'the artwork runs off the right edge').toBe(overflows);
			}
		);
	});
}

test(
	'with reduced motion the hero shows its static image and never fetches the Lottie',
	{ tag: '@CUR-2977' },
	async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const fetched: string[] = [];
		page.on('request', (r) => {
			if (new URL(r.url()).pathname.startsWith('/api/lottie/')) fetched.push(r.url());
		});
		await page.goto('/', { waitUntil: 'networkidle' });
		await expect(staticImage(page)).toBeVisible();
		await lottieSrc(page);
		await expect(wrapper(page)).toHaveAttribute('data-hero-art', 'static');
		expect(await opacityOf(page)).toBe('1');
		await expect(page.locator('[data-hero-animation]')).toHaveCount(0);
		expect(fetched, 'the Lottie was fetched under reduced motion').toEqual([]);
	}
);

test(
	'when the Lottie file fails to load, the static hero image fades in instead of leaving a gap',
	{ tag: '@CUR-2977' },
	async ({ page }) => {
		await page.route(/\/api\/lottie\//, (route) => route.abort());
		await page.goto('/');
		await expect(staticImage(page)).toBeVisible();
		await lottieSrc(page);
		await expect
			.poll(() => opacityOf(page), {
				message: 'the static image stayed hidden after the Lottie failed to load',
				timeout: 10_000
			})
			.toBe('1');
		// `fallback` when a Lottie gave up; `static` when none is configured.
		await expect(wrapper(page)).toHaveAttribute('data-hero-art', /^(fallback|static)$/);
		await expect(page.locator('[data-hero-animation="playing"]')).toHaveCount(0);
	}
);

test(
	'the configured hero Lottie is served from this origin as JSON',
	{ tag: '@CUR-2977' },
	async ({ page, request }) => {
		await page.goto('/');
		const src = await lottieSrc(page);
		if (!src) return;
		const res = await request.get(src);
		expect(res.status(), `${src} does not load`).toBe(200);
		expect(res.headers()['content-type']).toBe('application/json');
		const data = (await res.json()) as { w?: unknown; h?: unknown; layers?: unknown };
		expect(typeof data.w, 'not a Lottie: no width').toBe('number');
		expect(Array.isArray(data.layers), 'not a Lottie: no layers').toBe(true);
	}
);
