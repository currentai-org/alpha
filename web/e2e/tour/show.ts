import type { Locator, Page } from '@playwright/test';
import {
	click,
	highlight as recastHighlight,
	waitForNarration as recastWaitForNarration
} from 'playwright-recast/helpers';

// recast's highlight only measures the element's box and draws the mark there; it never scrolls, so
// an element below the fold gets a mark the viewer never sees (CUR-3071, A3's Forget everything).
// Tours import highlight from here so whatever the narration is about is on screen first.
export async function highlight(
	locator: Locator,
	opts?: Parameters<typeof recastHighlight>[1]
): Promise<void> {
	await locator.scrollIntoViewIfNeeded();
	await recastHighlight(locator, opts);
}

// recast pauses the video on whatever frame is showing when waitForNarration marks the cue's end. A
// locator check passes once the element is in the DOM, which can be half a second before the browser
// paints it, so A1's sign-in line froze on the chat answer behind the dialog. The second animation
// frame cannot run until the frame holding the change has been produced.
export async function waitForNarration(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
	);
	await recastWaitForNarration();
}

// The home page runs GSAP's ScrollSmoother (CUR-3321), which draws each block up to a second behind
// its layout box after a scroll. recast's click scrolls the link into view and clicks its layout box
// straight away, where the link is not drawn yet, so nothing navigated and every tour stopped on its
// first step (CUR-3337). The smoother only starts when motion is allowed, so the take opens the home
// page with reduced motion and allows motion again once it is in chat, which never loads the smoother.
export async function openHome(page: Page): Promise<void> {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/', { waitUntil: 'load' });
}

export async function clickIntoChat(page: Page): Promise<void> {
	await click(page.locator('a[href^="/chat"]:visible').first());
	await page.getByLabel('Message AI Potluck').waitFor({ timeout: 30_000 });
	await page.emulateMedia({ reducedMotion: 'no-preference' });
}

// One typing speed and one set of pauses for every tour (CUR-4219). A tour used to carry its own
// copy of these numbers, so a speed change reached only the tours someone remembered and a new tour
// copied whichever one it started from; each tour passes TOUR_RECAST to setupRecast and types
// anything outside recast's own typeText with TOUR_TYPING_DELAY_MS.
export const TOUR_TYPING_DELAY_MS = 15;

export const TOUR_RECAST = {
	typingDelayMs: TOUR_TYPING_DELAY_MS,
	hoverDwellMs: 350,
	clickSettleMs: 250,
	narrationSettleMs: 400
} as const;
