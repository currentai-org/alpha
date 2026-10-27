// e2e-product: @site
import { test, expect } from './helpers/test';

// The footer's newsletter signup hands the address to Tally and never puts it in one of
// our own URLs, because our request logs keep every URL with its query string. With its script
// running, a submit opens the Tally popup and the page stays where it is. Before the script runs,
// or with JavaScript off, the form submits to the Tally form itself, so the signup still goes through.
// Tally is stood in for both ways: nothing reaches tally.so and no real signup is made.

const ADDRESS = 'newsletter-e2e@example.org';

test.use({ viewport: { width: 1440, height: 900 } });

test(
	'with its script running, the newsletter signup opens the Tally popup with the address and our own URL never carries it',
	{ tag: '@CUR-4546' },
	async ({ page }) => {
		const ownRequestsWithAddress: string[] = [];
		page.on('request', (r) => {
			const url = new URL(r.url());
			if (url.hostname !== 'tally.so' && r.url().includes(encodeURIComponent(ADDRESS)))
				ownRequestsWithAddress.push(url.pathname);
		});
		// A stand-in for Tally's embed script that records what the popup was opened with.
		await page.route('https://tally.so/widgets/embed.js', (route) =>
			route.fulfill({
				contentType: 'text/javascript',
				body: `window.Tally = { openPopup(formId, options) {
					window.__tallyOpened = { formId, email: options && options.hiddenFields && options.hiddenFields.email };
				} };`
			})
		);
		await page.goto('/', { waitUntil: 'load' });
		const signup = page.locator('footer [data-block="email-signup"]').first();
		await signup.scrollIntoViewIfNeeded();
		await expect(signup, 'the footer has no newsletter signup').toBeVisible();

		const before = page.url();
		await signup.getByRole('textbox', { name: 'Email address' }).fill(ADDRESS);
		await signup.locator('button[type="submit"]').click();

		await expect
			.poll(() =>
				page.evaluate(() => (window as { __tallyOpened?: { email?: string } }).__tallyOpened?.email)
			)
			.toBe(ADDRESS);
		expect(page.url(), 'submitting navigated away from the page').toBe(before);
		expect(ownRequestsWithAddress, 'the address went to one of our own URLs').toEqual([]);
	}
);

test.describe('with JavaScript off', () => {
	test.use({ javaScriptEnabled: false });

	test(
		'the newsletter signup submits the address to the Tally form itself, never to one of our own URLs',
		{ tag: '@CUR-4546' },
		async ({ page }) => {
			const ownRequestsWithAddress: string[] = [];
			page.on('request', (r) => {
				const url = new URL(r.url());
				if (url.hostname !== 'tally.so' && r.url().includes(encodeURIComponent(ADDRESS)))
					ownRequestsWithAddress.push(url.pathname);
			});
			let tallyUrl: URL | null = null;
			await page.route('https://tally.so/r/**', (route) => {
				tallyUrl = new URL(route.request().url());
				return route.fulfill({ contentType: 'text/html', body: '<title>Tally stand-in</title>' });
			});

			await page.goto('/', { waitUntil: 'load' });
			const signup = page.locator('footer [data-block="email-signup"]').first();
			await expect(signup, 'the footer has no newsletter signup').toBeAttached();
			const action = await signup.locator('form').getAttribute('action');
			expect(action, "the footer signup's form does not point at a Tally form").toMatch(
				/^https:\/\/tally\.so\/r\/[^/?#]+$/
			);

			// The visitor scrolls to the footer and clicks Subscribe. app.css makes scrolling smooth, and
			// Playwright's own scroll-into-view under it never lets the button hold still
			// ("element is not stable" for 90 s), so the test scrolls the way a visitor's End
			// key does and clicks once the button's box has stopped moving.
			await page.keyboard.press('End');
			const subscribe = signup.locator('button[type="submit"]');
			let lastY: number | undefined;
			await expect(async () => {
				const y = (await subscribe.boundingBox())?.y;
				const settled = y !== undefined && y === lastY;
				lastY = y;
				expect(settled, 'the Subscribe button is still moving').toBe(true);
			}).toPass({ intervals: [250], timeout: 15_000 });
			await signup.getByRole('textbox', { name: 'Email address' }).fill(ADDRESS);
			await subscribe.click();
			await expect(page).toHaveTitle('Tally stand-in');

			const sent = tallyUrl as URL | null;
			expect(sent, 'the submit never reached the Tally form').not.toBeNull();
			expect(sent!.origin + sent!.pathname).toBe(action);
			expect(sent!.searchParams.get('email')).toBe(ADDRESS);
			expect(ownRequestsWithAddress, 'the address went to one of our own URLs').toEqual([]);
		}
	);
});
