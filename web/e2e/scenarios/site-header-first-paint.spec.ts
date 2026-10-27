// e2e-product: @site
import { test, expect } from './helpers/test';

// On every public page the header painted half-built for about a second (CUR-2269). The Products
// chevron and the "Help us improve the map" icons were missing, the logo was missing, and the nav
// label read differently once Plus Jakarta Sans arrived (the gallery's grader read it as "Gap Map"
// becoming "GapMap"). The server HTML already had all of it: the chevron and the icons are glyphs
// from the aipotluck-icons font, and nothing asked for that font until the first paint needed it.
//
// The contract: the first frame the header is on screen already has its icon font, its text face
// and its logo. Checked over a slow connection, because on a fast one they win the race by luck.

test.use({ viewport: { width: 1280, height: 720 } });

// Throttled with CDP below, which a cached, route-fulfilled asset would skip (helpers/test.ts).
test.use({ cacheStaticAssets: false });

// Render /map once off the browser before the test throttles it. The first request to a fresh
// deployment can spend most of a minute server-side, which has left the throttled page unpainted at
// 60 s while the retry painted in 10 s. A hook
// of its own, so the warm-up has its own budget and the test keeps its 90 s. A separate request
// context shares no HTTP cache with the page, so the fonts and logo still load cold.
test.beforeAll(async ({ playwright }, testInfo) => {
	testInfo.setTimeout(75_000);
	const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
	const warmStart = Date.now();
	const warm = await api.get('/map', { timeout: 60_000 });
	console.log(`warm /map: ${warm.status()} in ${Date.now() - warmStart} ms`);
	await api.dispose();
});

test(
	"the site header's first frame already has its icons, its font and its logo, even on a slow connection",
	{ tag: '@CUR-2269' },
	async ({ page, context }) => {
		test.setTimeout(90_000);
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 150,
			downloadThroughput: 200 * 1024,
			uploadThroughput: 100 * 1024
		});

		// Record the state on the first animation frame the header has height. A later read would
		// pass on a page that had already swapped.
		await page.addInitScript(() => {
			const w = window as unknown as { __headerFirstPaint?: Record<string, boolean> };
			const tick = () => {
				const header = document.querySelector('header');
				if (!header || header.getBoundingClientRect().height === 0)
					return requestAnimationFrame(tick);
				const logo = header.querySelector<HTMLImageElement>('img[alt="AI Potluck"]');
				w.__headerFirstPaint = {
					'icon font': document.fonts.check('16px aipotluck-icons', '\uf119' /* chevron-down */),
					'Plus Jakarta Sans': document.fonts.check('13px "Plus Jakarta Sans"', 'Products'),
					logo: !!logo && logo.complete && logo.naturalWidth > 0
				};
			};
			requestAnimationFrame(tick);
		});

		// Wait on the probe itself, not on the header being visible: Playwright reads visibility from
		// layout, which settles seconds before a render-blocked page paints its first frame here.
		await page.goto('/map', { waitUntil: 'commit' });
		const handle = await page.waitForFunction(
			() =>
				(window as unknown as { __headerFirstPaint?: Record<string, boolean> }).__headerFirstPaint,
			undefined,
			{ timeout: 60_000 }
		);
		const state = (await handle.jsonValue()) as Record<string, boolean>;
		expect(
			state,
			'the header painted before its icons, font or logo had loaded, so it pops in a moment later'
		).toEqual({ 'icon font': true, 'Plus Jakarta Sans': true, logo: true });
	}
);
