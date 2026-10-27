// e2e-product: @chat
// e2e-area: @composer
import { test, expect, type Page } from './helpers/test';
import { setFlagOverrides } from './helpers/flagOverride';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// The guided tour: a ring around each of Alpha's own features in turn (Auto, Languages, Private,
// X-ray, the session footprint, Get involved), a card saying what it is, and a "try it" that opens
// the real feature. A first-time visitor meets the "Welcome to Alpha" dialog over the whole app,
// whose "Take the tour" starts it; anyone can take it later from the account menu's Help group.
//
// Skipping the welcome leaves a hint directly above the sidebar's account row saying the tour is in
// that menu. On a phone, where that row is in the closed drawer, a toast says so too, and its
// "Show me" opens the drawer onto the hint.
//
// `auto-routing` is forced on because the Languages pill exists only with Auto choosing.

const WELCOME = 'Welcome to Alpha';

async function arrive(page: Page) {
	await page.goto('/chat', { waitUntil: 'commit' });
	const welcome = page.getByRole('dialog', { name: WELCOME });
	await expect(welcome, 'a first-time visitor got no welcome').toBeVisible({ timeout: 30_000 });
	return welcome;
}

async function openHelpTour(page: Page) {
	await page.getByRole('button', { name: /^Account/ }).click();
	await page.locator('[data-take-tour]').click();
}

test.describe('the guided tour', () => {
	test.use({ locale: 'en-GB', viewport: { width: 1280, height: 900 } });

	test.beforeEach(async ({ context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'auto-routing': true });
	});

	test('the welcome covers the whole app, and its Take the tour visits each feature, a try-it opening the real one', async ({
		page
	}) => {
		const welcome = await arrive(page);

		// Over everything, sidebar included: what sits under the sidebar's account row is the backdrop.
		const account = (await page.getByRole('button', { name: /^Account/ }).boundingBox())!;
		const onTop = await page.evaluate(
			([x, y]) =>
				document.elementFromPoint(x, y)?.closest('[data-welcome], [data-account-trigger]') === null,
			[account.x + account.width / 2, account.y + account.height / 2]
		);
		expect(onTop, 'the sidebar account row is still reachable through the welcome').toBe(true);
		await expect(
			welcome.locator('[data-welcome-tour]'),
			'Enter does not take the tour'
		).toBeFocused();

		await welcome.locator('[data-welcome-tour]').click();
		await expect(welcome).toHaveCount(0);

		const card = page.locator('[data-tour-card]');
		const ring = page.locator('[data-tour-ring]');
		await expect(card).toHaveAttribute('data-tour-card', 'auto');
		await expect(ring).toBeVisible();
		await expect(card.locator('[data-tour-next]')).toBeFocused();

		// The ring sits on the feature the card names: the model button.
		const modelBox = (await page.locator('[data-model-pill]').boundingBox())!;
		const ringBox = (await ring.boundingBox())!;
		expect(ringBox.x).toBeLessThanOrEqual(modelBox.x);
		expect(ringBox.x + ringBox.width).toBeGreaterThanOrEqual(modelBox.x + modelBox.width);

		await card.locator('[data-tour-next]').click();
		await expect(card).toHaveAttribute('data-tour-card', 'languages');

		// "See the languages" opens the real Languages panel and parks the tour behind a Resume chip.
		await card.locator('[data-tour-cta]').click();
		await expect(page.locator('[data-language-support-panel]')).toBeVisible();
		await expect(card).toHaveCount(0);
		const resume = page.locator('[data-tour-resume]');
		await expect(resume).toContainText('Resume tour');
		await resume.locator('[data-tour-resume-button]').click();
		// Resuming closes what the try-it opened and goes on to the next stop.
		await expect(page.locator('[data-language-support-panel]')).toHaveCount(0);
		await expect(card).toHaveAttribute('data-tour-card', 'privacy');

		const visited = ['auto', 'languages', 'privacy'];
		for (;;) {
			const next = card.locator('[data-tour-next]');
			if ((await next.textContent())?.trim() === 'Done') break;
			await next.click();
			visited.push((await card.getAttribute('data-tour-card'))!);
		}
		expect(visited).toEqual(['auto', 'languages', 'privacy', 'xray', 'footprint', 'get-involved']);
		await expect(card.locator('[data-tour-progress]')).toHaveText(/6 of 6/i);

		await card.locator('[data-tour-next]').click();
		await expect(card).toHaveCount(0);
		await expect(ring).toHaveCount(0);
		// Taking the tour is not a skip: nothing points at where it lives.
		await expect(page.locator('[data-tour-hint]')).toHaveCount(0);
	});

	test('skipping the welcome points at the account menu above its row until the person opens it, where Take the tour starts it', async ({
		page
	}) => {
		const welcome = await arrive(page);
		await welcome.getByRole('button', { name: /start chatting/i }).click();
		await expect(welcome).toHaveCount(0);
		await expect(
			page.locator('[data-chat-input]'),
			'Start chatting left the composer unfocused'
		).toBeFocused();

		const hint = page.locator('[data-tour-hint]');
		await expect(hint, 'a skip left nothing saying where the tour is').toBeVisible();
		await expect(hint).toContainText('take the tour any time from your account menu');
		// Directly above the row it names, and no toast: the row is on screen.
		const hintBox = (await hint.boundingBox())!;
		const rowBox = (await page.locator('[data-account-trigger]').boundingBox())!;
		expect(rowBox.y - (hintBox.y + hintBox.height)).toBeGreaterThanOrEqual(0);
		expect(rowBox.y - (hintBox.y + hintBox.height)).toBeLessThan(24);
		await expect(page.getByTestId('tour-hint-toast')).toHaveCount(0);

		// Still there on the next visit, until found.
		await page.reload();
		await expect(hint).toBeVisible({ timeout: 30_000 });

		await openHelpTour(page);
		const card = page.locator('[data-tour-card]');
		await expect(card).toHaveAttribute('data-tour-card', 'auto');
		await expect(card.locator('[data-tour-next]')).toBeFocused();
		await expect(hint, 'the hint stayed after the person found the tour').toHaveCount(0);
		await page.keyboard.press('Enter');
		await expect(card).toHaveAttribute('data-tour-card', 'languages');
		await card.locator('[data-tour-back]').click();
		await expect(card).toHaveAttribute('data-tour-card', 'auto');

		await page.keyboard.press('Escape');
		await expect(card).toHaveCount(0);
		await expect(page.locator('[data-tour-ring]')).toHaveCount(0);
		await page.reload();
		await expect(page.locator('[data-account-trigger]')).toBeVisible({ timeout: 30_000 });
		await expect(hint).toHaveCount(0);
	});

	test.describe('on a phone', () => {
		test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

		test('the welcome is a bottom sheet, and a skip says where the tour is, with a Show me that opens the drawer onto the hint', async ({
			page
		}) => {
			const welcome = await arrive(page);
			await expect(welcome).toHaveAttribute('data-sheet');
			await expect
				.poll(async () =>
					Math.round((await welcome.boundingBox())!.y + (await welcome.boundingBox())!.height)
				)
				.toBe(844);

			await welcome.getByRole('button', { name: /start chatting/i }).click();
			await expect(welcome).toHaveCount(0);

			const toast = page.getByTestId('tour-hint-toast');
			await expect(
				toast,
				'a phone skip said nothing, though the account row is in the closed drawer'
			).toBeVisible();
			await toast.getByRole('button', { name: 'Show me' }).click();

			const hint = page.locator('[data-tour-hint]');
			await expect(hint).toBeVisible();
			await expect(hint).toBeInViewport();
			await expect(page.locator('[data-account-trigger]')).toBeInViewport();
		});

		test("the sheet's Take the tour walks the phone through, opening the drawer for the stop that lives in it", async ({
			page
		}) => {
			const welcome = await arrive(page);
			await welcome.locator('[data-welcome-tour]').click();
			await expect(welcome).toHaveCount(0);
			const card = page.locator('[data-tour-card]');
			const ring = page.locator('[data-tour-ring]');
			const drawer = page.locator('aside[data-mobile-open]');
			await expect(card).toHaveAttribute('data-tour-card', 'auto');
			await expect(card).toBeInViewport();
			await expect(drawer).toHaveCount(0);

			for (;;) {
				const next = card.locator('[data-tour-next]');
				if ((await next.textContent())?.trim() === 'Done') break;
				await next.click();
			}
			// Get involved is the last stop, and its card sits in the sidebar: the drawer opens onto it, and
			// the ring is on it rather than off the left edge where the closed drawer keeps it.
			await expect(card).toHaveAttribute('data-tour-card', 'get-involved');
			await expect(drawer, 'the drawer stayed shut on the stop that lives in it').toHaveCount(1);
			await expect(page.locator('[data-get-involved]')).toBeInViewport({ ratio: 1 });
			await expect
				.poll(async () => (await ring.boundingBox())!.x, { message: 'the ring sits off screen' })
				.toBeGreaterThanOrEqual(0);
			// The card is above the pushed, faded conversation, and still takes a tap.
			await card.locator('[data-tour-back]').click();
			await expect(card).not.toHaveAttribute('data-tour-card', 'get-involved');
			await expect(drawer, 'going back left the drawer over the stop before').toHaveCount(0);
			await card.locator('[data-tour-next]').click();
			await expect(drawer).toHaveCount(1);
			await card.locator('[data-tour-next]').click();
			await expect(card).toHaveCount(0);
			await expect(drawer, 'the tour ended with the drawer it opened still open').toHaveCount(0);
		});
	});
});
