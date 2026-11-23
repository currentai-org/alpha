// e2e-product: @site
import { test, expect, type Page } from './helpers/test';

// The header's Products dropdown opens on a short hover and closes a moment after the pointer
// leaves. site-header.svelte sets that timing itself (DROPDOWN_OPEN_DELAY_MS 120,
// DROPDOWN_CLOSE_DELAY_MS 300). The timing tests pause the page clock and step it, so a quick pass
// over the trigger is a fixed 60 ms however slow the runner is, never a race against it.

test.use({ viewport: { width: 1440, height: 900 } });

const trigger = (page: Page) => page.locator('header nav button').filter({ hasText: 'Products' });
const panel = (page: Page) => page.locator('[data-slot="navigation-menu-content"]');
// A point well clear of the header and the open panel.
const AWAY = { x: 10, y: 700 };

async function pointAtTrigger(page: Page) {
	const box = await trigger(page).boundingBox();
	if (!box) throw new Error('the Products trigger has no box');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
const moveAway = (page: Page) => page.mouse.move(AWAY.x, AWAY.y);

// Hovering opens the panel only once the page has hydrated, so a hover that opens it and a leave
// that closes it again is the readiness check for the tests that then drive it another way.
async function waitHydrated(page: Page) {
	await expect(trigger(page)).toBeVisible();
	await expect
		.poll(
			async () => {
				await pointAtTrigger(page);
				return panel(page).isVisible();
			},
			{ message: 'hovering Products never opened it (page not hydrated?)', timeout: 15_000 }
		)
		.toBe(true);
	await moveAway(page);
	await expect(panel(page), 'the panel stayed open after the pointer left').toBeHidden();
}

// The clock is paused after the readiness check: the pause target comes from the page's own clock,
// retried with a wider margin if a slow round trip leaves it in the past.
async function openPageWithPausedClock(page: Page) {
	await page.clock.install();
	await page.goto('/');
	await waitHydrated(page);
	for (let margin = 50; ; margin *= 2) {
		const pageNow = await page.evaluate(() => Date.now());
		try {
			await page.clock.pauseAt(pageNow + margin);
			break;
		} catch (error) {
			if (margin >= 800 || !/fast-forward to the past/.test(String(error))) throw error;
		}
	}
	await page.clock.runFor(1_000);
}

// Steps the paused clock a frame at a time, at most `frames` frames, until the panel is shown (or
// hidden), so a frame-timed mount inside bits-ui still happens while the delay's upper bound holds:
// a panel that needs more frames than the budget fails, however long the runner would wait.
async function expectWithinFrames(page: Page, shown: boolean, frames: number, message: string) {
	for (let i = 0; i < frames; i++) {
		await page.clock.runFor(16);
		if ((await panel(page).isVisible()) === shown) return;
	}
	expect(await panel(page).isVisible(), message).toBe(shown);
}
// Opening by about 190 ms from the first point at the trigger, from a call site at 130 or 150 ms.
const expectOpens = (page: Page, frames: number, message: string) =>
	expectWithinFrames(page, true, frames, message);
// The trigger's aria-expanded flips the moment the menu decides to close, while the panel itself
// stays painted through its exit animation, which runs in real time outside the paused clock. So the
// close delay's bounds are read from the trigger, and the panel is then waited out until it is gone.
const expanded = (page: Page) => trigger(page).getAttribute('aria-expanded');
async function expectStillOpen(page: Page, message: string) {
	expect(await expanded(page), message).toBe('true');
}
// Closing by about 375 ms after the pointer left, from a call site at 310 ms.
async function expectCloses(page: Page, message: string) {
	for (let i = 0; i < 4 && (await expanded(page)) !== 'false'; i++) await page.clock.runFor(16);
	expect(await expanded(page), message).toBe('false');
	await expect
		.poll(
			async () => {
				await page.clock.runFor(16);
				return panel(page).isVisible();
			},
			{ message: 'the closed panel never left the page' }
		)
		.toBe(false);
}

test.describe('Products dropdown timing', () => {
	test('a quick pass over Products does not open it, and resting on it opens it after about 120 ms', async ({
		page
	}) => {
		await openPageWithPausedClock(page);

		// "it no longer flickers open when the mouse passes over it"
		await pointAtTrigger(page);
		await page.clock.runFor(60);
		await moveAway(page);
		await page.clock.runFor(500);
		await expect(panel(page), 'a 60 ms pass over the trigger opened the panel').toBeHidden();

		await pointAtTrigger(page);
		await page.clock.runFor(100);
		await expect(panel(page), 'the panel opened before about 120 ms').toBeHidden();
		await page.clock.runFor(30);
		await expectOpens(page, 4, 'resting on Products did not open it by about 190 ms');
	});

	test('leaving Products closes it about 300 ms later, and coming back within that time keeps it open', async ({
		page
	}) => {
		await openPageWithPausedClock(page);
		await pointAtTrigger(page);
		await page.clock.runFor(150);
		await expectOpens(page, 3, 'resting on Products did not open it by about 190 ms');

		// Still open 250 ms after leaving, and still open 50 ms after coming back, before the 120 ms
		// hover delay could have reopened a menu that had closed in between.
		await moveAway(page);
		await page.clock.runFor(250);
		await expectStillOpen(page, 'the menu closed within 250 ms of the pointer leaving');
		await pointAtTrigger(page);
		await page.clock.runFor(50);
		await expectStillOpen(page, 'coming back within 300 ms let the menu close');
		await page.clock.runFor(600);
		await expect(panel(page), 'coming back within 300 ms did not keep it open').toBeVisible();

		await moveAway(page);
		await page.clock.runFor(250);
		await expectStillOpen(page, 'the menu closed before about 300 ms');
		await page.clock.runFor(60);
		await expectCloses(page, 'the panel stayed open after the pointer left');
	});

	test('moving from Products down into its panel keeps it open, and a click after hovering keeps it open', async ({
		page
	}) => {
		await openPageWithPausedClock(page);
		await pointAtTrigger(page);
		await page.clock.runFor(150);
		await expectOpens(page, 3, 'resting on Products did not open it by about 190 ms');

		// Down through the gap between the bar and the panel, in small steps, into the panel.
		const box = await panel(page).boundingBox();
		if (!box) throw new Error('the open panel has no box');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
		await page.clock.runFor(600);
		await expect(panel(page), 'moving into the panel closed it').toBeVisible();

		await pointAtTrigger(page);
		await page.mouse.down();
		await page.mouse.up();
		await page.clock.runFor(600);
		await expect(panel(page), 'a click after hovering closed the panel').toBeVisible();
	});
});

test('the keyboard toggles Products with Enter and Space and closes it with Escape', async ({
	page
}) => {
	await page.goto('/');
	await waitHydrated(page);
	const button = trigger(page);
	await button.focus();
	await expect(button).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(panel(page), 'Enter did not open Products').toBeVisible();
	await button.focus();
	await page.keyboard.press('Enter');
	await expect(panel(page), 'Enter did not close Products').toBeHidden();
	await page.keyboard.press('Space');
	await expect(panel(page), 'Space did not open Products').toBeVisible();
	await page.keyboard.press('Escape');
	await expect(panel(page), 'Escape did not close Products').toBeHidden();
});

test('while Products is closed, tabbing through the header never lands on one of its links', async ({
	page
}) => {
	await page.goto('/');
	await waitHydrated(page);
	await page.locator('header a').first().focus();
	for (let i = 0; i < 20; i++) {
		const where = await page.evaluate(() => {
			const el = document.activeElement;
			return {
				inPanel: !!el?.closest('[data-slot="navigation-menu-content"]'),
				inHeader: !!el?.closest('header')
			};
		});
		expect(where.inPanel, `Tab ${i} focused a link in the closed Products panel`).toBe(false);
		if (!where.inHeader) break;
		await page.keyboard.press('Tab');
	}
	await expect(panel(page), 'tabbing past Products opened it').toBeHidden();
});

// Records each animation that starts on the panel, with the duration and easing it ran with.
async function recordPanelAnimations(page: Page) {
	await page.evaluate(() => {
		const log: {
			name: string;
			duration: string;
			easing: string;
			enterOpacity: string;
			enterY: string;
		}[] = [];
		(window as unknown as { __panelAnimations: typeof log }).__panelAnimations = log;
		document.addEventListener('animationstart', (e) => {
			const el = e.target as HTMLElement;
			if (el.getAttribute('data-slot') !== 'navigation-menu-content') return;
			const cs = getComputedStyle(el);
			log.push({
				name: e.animationName,
				duration: cs.animationDuration,
				easing: cs.animationTimingFunction,
				enterOpacity: cs.getPropertyValue('--tw-enter-opacity').trim(),
				enterY: cs.getPropertyValue('--tw-enter-translate-y').trim()
			});
		});
	});
}
const panelAnimations = (page: Page) =>
	page.evaluate(
		() =>
			(
				window as unknown as {
					__panelAnimations: {
						name: string;
						duration: string;
						easing: string;
						enterOpacity: string;
						enterY: string;
					}[];
				}
			).__panelAnimations
	);

test('Products fades in and slides down over about 200 ms, ease-out, and fades back out the same way', async ({
	page
}) => {
	await page.goto('/');
	await expect(trigger(page)).toBeVisible();
	await recordPanelAnimations(page);
	await expect
		.poll(
			async () => {
				await trigger(page).hover();
				return panel(page).isVisible();
			},
			{ message: 'hovering Products never opened it', timeout: 15_000 }
		)
		.toBe(true);
	await moveAway(page);
	await expect(panel(page)).toBeHidden();

	const runs = await panelAnimations(page);
	const enter = runs.find((r) => r.name === 'enter');
	const exit = runs.find((r) => r.name === 'exit');
	expect(enter, `no enter animation on open: ${JSON.stringify(runs)}`).toBeTruthy();
	expect(exit, `no exit animation on close: ${JSON.stringify(runs)}`).toBeTruthy();
	for (const run of [enter!, exit!]) {
		expect(run.duration, `${run.name} did not run for 200 ms`).toBe('0.2s');
		expect(run.easing, `${run.name} is not the ease-out curve`).toBe(
			'cubic-bezier(0.22, 1, 0.36, 1)'
		);
	}
	expect(enter!.enterOpacity, 'the panel does not fade in from transparent').toBe('0');
	expect(enter!.enterY, 'the panel does not slide down from above').not.toBe('');
});

test.describe('with reduced motion', () => {
	test.use({ reducedMotion: 'reduce' });

	test('Products opens and closes without the animation', async ({ page }) => {
		await page.goto('/');
		await expect(trigger(page)).toBeVisible();
		await recordPanelAnimations(page);
		await expect
			.poll(
				async () => {
					await trigger(page).hover();
					return panel(page).isVisible();
				},
				{ message: 'hovering Products never opened it', timeout: 15_000 }
			)
			.toBe(true);
		expect(
			await panel(page).evaluate((el) => getComputedStyle(el).animationName),
			'the panel animates with reduced motion on'
		).toBe('none');
		await moveAway(page);
		await expect(panel(page)).toBeHidden();
		expect(await panelAnimations(page), 'an animation ran with reduced motion on').toEqual([]);
	});
});

test.describe('on a touch screen', () => {
	test.use({ hasTouch: true });

	test('a tap opens Products and a second tap closes it', async ({ page }) => {
		await page.goto('/');
		await waitHydrated(page);
		const button = trigger(page);
		await button.tap();
		await expect(panel(page), 'a tap did not open Products').toBeVisible();
		await button.tap();
		await expect(panel(page), 'a second tap did not close Products').toBeHidden();
	});
});
