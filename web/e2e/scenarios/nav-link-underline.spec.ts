// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';
import { scrollFooterToRest } from './helpers/footer';

// Header and footer nav links rest without an underline. On hover (or keyboard focus)
// the line draws in from the left (link-draw in app.css, link-pulse's underline run the other
// way) and then holds, with nothing left animating; leaving retracts it.

test.use({ viewport: { width: 1440, height: 900 } });

const lineSize = (link: Locator) =>
	link.evaluate((el) => getComputedStyle(el).backgroundSize.split(',').at(-1)!.trim());
const running = (link: Locator) =>
	link.evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length);

const navLinks = {
	header: (page: Page) =>
		page.locator('header nav a:not([data-slot="button"])').filter({ visible: true }).first(),
	footer: (page: Page) => page.locator('footer nav a').filter({ visible: true }).first()
};

for (const [where, find] of Object.entries(navLinks)) {
	test(
		`a ${where} nav link draws its underline on hover, holds it still, and retracts it on leave`,
		{ tag: '@CUR-4033' },
		async ({ page }) => {
			await page.goto('/');
			const link = find(page);
			// The footer lags under ScrollSmoother, so Playwright's own scroll can leave it under the
			// fixed header, which then takes the hover (CUR-4492).
			if (where === 'footer') await scrollFooterToRest(page, link);
			else await link.scrollIntoViewIfNeeded();
			expect(await lineSize(link), 'the link is underlined before hovering').toBe('0% 1px');

			await link.hover();
			await expect
				.poll(() => lineSize(link), { message: 'the underline never finished drawing' })
				.toBe('100% 1px');
			// Drawn means done: no transition still running, and the line stays put while hovered.
			await expect.poll(() => running(link), { message: 'still animating once drawn' }).toBe(0);
			await page.waitForTimeout(600);
			expect(await lineSize(link), 'the underline moved after it had drawn').toBe('100% 1px');

			await page.mouse.move(0, 0);
			await expect
				.poll(() => lineSize(link), { message: 'the underline stayed after the pointer left' })
				.toBe('0% 1px');
		}
	);
}

test(
	'keyboard focus on a header nav link shows the same underline',
	{ tag: '@CUR-4033' },
	async ({ page }) => {
		await page.goto('/');
		const link = navLinks.header(page);
		await link.focus();
		await expect(link).toBeFocused();
		await expect
			.poll(() => lineSize(link), { message: 'focus drew no underline' })
			.toBe('100% 1px');
	}
);

test.describe('with reduced motion', () => {
	test.use({ reducedMotion: 'reduce' });

	test(
		'a header nav link underlines on hover without animating',
		{ tag: '@CUR-4033' },
		async ({ page }) => {
			await page.goto('/');
			const link = navLinks.header(page);
			// Read straight after the hover, with no polling: a running transition would still be
			// partway, and `motion-reduce:transition-none` turns off the property list, not the
			// duration, so the computed duration says nothing here.
			await link.hover();
			expect(await lineSize(link), 'the underline did not appear at once').toBe('100% 1px');
			expect(await running(link), 'the underline animated with reduced motion on').toBe(0);
		}
	);
});
