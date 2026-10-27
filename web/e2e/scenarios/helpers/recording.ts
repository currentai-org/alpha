import type { Page } from '@playwright/test';

// The journey grader keeps a frame of a screen only if it stayed up for at least 0.5s
// (MIN_HOLD_SECONDS in scripts/critique-journey.mjs), and it samples about one frame a second. A
// spec that asserts a dialog and confirms it in the same breath leaves that dialog on screen for
// tens of milliseconds, so the step passes and the grader reports it "claimed but not seen"
// (CUR-2289). 1.2s clears the floor with room for a slow CI encoder
// and stays under the 2s at which the grader starts reading a screen as stuck.
const READABLE_HOLD_MS = 1_200;
const RECORDING = process.env.SCENARIO_VIDEO === '1';

/**
 * Holds the current screen long enough for the journey recording to keep a frame of it.
 *
 * @remarks A deliberate pause for the camera; it waits on nothing in the app. Call it only after
 * asserting the state it shows, and only on a screen a journey step claims, such as a confirmation
 * a person reads before choosing. Anything the test is waiting FOR still gets an `expect`.
 */
export async function holdForRecording(page: Page): Promise<void> {
	// Nothing records unless SCENARIO_VIDEO is set (playwright.config.ts, SOL-196), so nothing needs holding.
	if (!RECORDING) return;
	await page.waitForTimeout(READABLE_HOLD_MS);
}

/**
 * Puts a "Test step: …" banner on screen and holds it for the recording, for a step the camera
 * cannot show, such as a `page.goto` typed into an address bar the recording does not contain.
 *
 * @remarks Without it the grader sees only the result. Opening a deleted chat's old link raises
 * "That conversation isn't available in this session.", and with no visible cause the grader filed
 * it as an unprompted error (CUR-2664). The banner comes down after the hold: left up, it covered
 * the product for 18 s of A3's 68 s demo reel (CUR-2986). Pass `at: 'top'` when the step happens
 * at the bottom of the screen, such as a tap on a pill under the message box, so the banner does
 * not cover it.
 */
export async function captionForRecording(
	page: Page,
	text: string,
	{ at = 'bottom' }: { at?: 'top' | 'bottom' } = {}
): Promise<void> {
	if (!RECORDING) return;
	await page.evaluate(
		({ caption, edge }) => {
			const el = document.createElement('div');
			el.setAttribute('data-e2e-caption', '');
			el.textContent = `Test step: ${caption}`;
			Object.assign(el.style, {
				position: 'fixed',
				left: '50%',
				[edge]: '24px',
				transform: 'translateX(-50%)',
				zIndex: '2147483647',
				background: '#ffd400',
				color: '#000',
				font: '600 16px system-ui, sans-serif',
				padding: '8px 14px',
				pointerEvents: 'none'
			});
			document.body.appendChild(el);
		},
		{ caption: text, edge: at }
	);
	await holdForRecording(page);
	await page.evaluate(() => {
		for (const el of document.querySelectorAll('[data-e2e-caption]')) el.remove();
	});
}
