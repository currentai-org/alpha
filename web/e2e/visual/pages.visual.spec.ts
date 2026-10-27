// CUR-1512 — viewport screenshots, not full-page: the failure mode this guards against ("a CSS
// change moves a control offscreen, collapses a panel") is a viewport-level concern, and a full-page
// capture would also pull in whatever's below the fold, adding surface area to a suite meant to stay
// small and deterministic.
import { test, expect, type Locator } from '@playwright/test';
import { CHAT_ENTRY } from '../scenarios/helpers/chatEntry';
import { skipVercelToolbar } from '../scenarios/helpers/vercelToolbar';

// CUR-2132 — Vercel injects its toolbar (vercel.live feedback.js) into preview deployments, a round
// widget on the right edge that production never shows; `x-vercel-skip-toolbar` opts automation out.
// Same-origin only: on a cross-origin fetch a custom header forces a CORS preflight the target may refuse.
test.beforeEach(async ({ page, baseURL }) => {
	await skipVercelToolbar(page, baseURL!);
});

// CUR-2539 — a mask whose locator matches nothing masks nothing, and the screenshot then passes or
// fails on pixels nobody meant to compare. Each mask must match exactly one visible element inside the
// viewport, or the test fails here and names the mask. In the baseline, each mask is a solid magenta box.
async function maskOf(name: string, locator: Locator): Promise<Locator> {
	await expect(locator, `mask "${name}" matches no element, or more than one`).toHaveCount(1);
	await expect(locator, `mask "${name}" is not visible`).toBeVisible();
	const box = await locator.boundingBox();
	const viewport = locator.page().viewportSize();
	expect(
		box && viewport && box.y < viewport.height && box.width > 0 && box.height > 0,
		`mask "${name}" sits outside the viewport: ${JSON.stringify(box)}`
	).toBe(true);
	return locator;
}

test('home page renders as expected', async ({ page }) => {
	// CUR-2977 — a hero with a Lottie set plays it after hydration, so a capture at `load` would land
	// on a different frame each run. Under reduced motion the hero shows its static image instead.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/', { waitUntil: 'load' });
	// CUR-2542 — the hero's updates tile counts CMS posts over a rolling window ("3 Updates · In the
	// past 2 weeks"), so it comes and goes with the calendar. A mask drew a magenta box into the
	// baseline when the tile was there and nothing when it was not, so every PR went red once the
	// window emptied (CUR-2683). Hide it instead: at desktop width it is absolutely positioned, so the
	// page renders the same with or without it, and only the tile's own box goes unchecked.
	await page.addStyleTag({
		content: '[data-block="recent-updates"] { visibility: hidden !important; }'
	});
	// CUR-2539 — the hero's title, paragraph and call-to-action button are CMS copy, edited without a code
	// change, and each edit turned every PR's check red. A mask keeps its element's box, so a change to
	// the hero's type scale or layout still moves or resizes a magenta box and still fails here. The mask
	// is the title's column rather than the title itself: the title's descenders hang below its own box.
	const heroCopy = await maskOf(
		'hero copy',
		page.getByRole('heading', { level: 1 }).locator('xpath=..')
	);
	await expect(page).toHaveScreenshot('home.png', { mask: [heroCopy] });
});

test('chat entry page renders as expected', async ({ page }) => {
	await page.goto(CHAT_ENTRY, { waitUntil: 'load' });
	// CUR-2132 — WelcomeModal renders every action disabled (opacity-50) until it hydrates, and the
	// first baseline caught that pre-hydration frame. Capture the hydrated page only.
	await expect(page.getByRole('button', { name: 'Start chatting' })).toBeEnabled();
	await expect(page).toHaveScreenshot('chat-entry.png');
});
