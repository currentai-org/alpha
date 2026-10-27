// e2e-product: @site
import { test, expect } from './helpers/test';
import { pageWithBlock } from './helpers/contentPages';

// The Call To Actions block is a centred title over a row of next steps, each an icon
// beside a title and subtitle that links somewhere or opens a Tally form. Text & Updates is a large
// heading beside text, buttons and the newest updates. Each test runs on the first page in this
// environment's sitemap that carries its block; where no page does, it records that nothing was
// checked rather than passing on an assertion it never made.

test.use({ viewport: { width: 1440, height: 900 } });

test(
	'the Text & Updates block shows its heading beside its text and buttons',
	{ tag: '@CUR-3971' },
	async ({ page, request }) => {
		const path = await pageWithBlock(request, 'text-updates');
		if (!path) {
			test.info().annotations.push({
				type: 'no text & updates block',
				description:
					"no page in this environment's sitemap has a Text & Updates block, so nothing was checked"
			});
			return;
		}
		await page.goto(path, { waitUntil: 'domcontentloaded' });
		const block = page.locator('[data-block="text-updates"]').first();
		await expect(
			block,
			`${path} served the block but the browser did not render it`
		).toBeAttached();
		await block.scrollIntoViewIfNeeded();
		const heading = block.getByRole('heading', { level: 2 });
		await expect(heading).toBeVisible();
		await expect(heading).not.toBeEmpty();

		const buttons = block.getByRole('link').or(block.getByRole('button'));
		await expect(buttons.first()).toBeVisible();
		const [headingBox, buttonBox] = [
			await heading.boundingBox(),
			await buttons.first().boundingBox()
		];
		expect(buttonBox!.x, 'the buttons are not beside the heading').toBeGreaterThan(
			headingBox!.x + headingBox!.width
		);
	}
);

test(
	'the Call To Actions block centres its title over actions that each show an icon, a title and a subtitle, and a Tally action, where the content has one, opens its form',
	{ tag: '@CUR-3971' },
	async ({ page, request }) => {
		const path = await pageWithBlock(request, 'callToActions');
		if (!path) {
			test.info().annotations.push({
				type: 'no call to actions block',
				description:
					"no page in this environment's sitemap has a Call To Actions block, so nothing was checked"
			});
			return;
		}
		await page.goto(path, { waitUntil: 'domcontentloaded' });
		const section = page.locator('section[data-block="callToActions"]').first();
		await expect(
			section,
			`${path} served the block but the browser did not render it`
		).toBeAttached();
		await section.scrollIntoViewIfNeeded();
		const title = section.getByRole('heading', { level: 2 });
		await expect(title).toBeVisible();
		const [sectionBox, titleBox] = [await section.boundingBox(), await title.boundingBox()];
		const offCentre = Math.abs(
			titleBox!.x + titleBox!.width / 2 - (sectionBox!.x + sectionBox!.width / 2)
		);
		expect(offCentre, 'the title is not centred in the block').toBeLessThan(4);

		const actions = section.locator('li');
		const count = await actions.count();
		expect(count, 'the block renders no actions').toBeGreaterThan(0);
		for (let i = 0; i < count; i++) {
			const action = actions.nth(i);
			await expect(
				action.locator('i[aria-hidden="true"]'),
				`action ${i + 1} has no icon`
			).toBeVisible();
			const lines = action.locator('span > span');
			await expect(lines.first(), `action ${i + 1} has no title`).not.toBeEmpty();
			await expect(lines.nth(1), `action ${i + 1} has no subtitle`).not.toBeEmpty();
		}

		// An action is a link or a Tally form, chosen per action in the CMS, so an environment's
		// content can carry no Tally action at all. Record that rather than failing the layout checks
		// above on content, the way a missing block is recorded.
		const tallyAction = section.getByRole('button').first();
		if ((await section.getByRole('button').count()) === 0) {
			test.info().annotations.push({
				type: 'no tally action',
				description: `the Call To Actions block on ${path} has no Tally action, so opening a Tally form was not checked`
			});
			return;
		}
		await expect(tallyAction, 'the Tally action is not visible').toBeVisible();
		// The button's job is to load Tally's embed script and call Tally.openPopup with the action's
		// form id. Whether tally.so then answers the CI runner is Tally's, so a stand-in script records
		// the call and opens the iframe the real one would.
		await page.route('https://tally.so/widgets/embed.js', (route) =>
			route.fulfill({
				contentType: 'text/javascript',
				body: `window.Tally = { openPopup(formId) {
					if (!formId || document.querySelector('iframe[data-test-tally]')) return;
					const frame = document.createElement('iframe');
					frame.dataset.testTally = formId;
					frame.src = 'https://tally.so/popup/' + encodeURIComponent(formId);
					frame.style.cssText = 'position:fixed;inset:10%;width:80%;height:80%;z-index:9999';
					document.body.appendChild(frame);
				} };`
			})
		);
		await page.route(/^https:\/\/tally\.so\/popup\//, (route) =>
			route.fulfill({ contentType: 'text/html', body: '<p>form</p>' })
		);
		// The button is server-rendered and a click does nothing until hydration attaches its handler,
		// which Svelte 5 stores on the element under a `Symbol('events')` key (see
		// helpers/composer.ts). The click retry below gave up after 15 s on a cold preview that hydrated
		// later, so wait for the handler first (SOL-283); the retry then only covers the embed script.
		await expect
			.poll(
				() =>
					tallyAction.evaluate((el) =>
						Object.getOwnPropertySymbols(el).some(
							(key) =>
								key.description === 'events' &&
								typeof (el as unknown as Record<symbol, Record<string, unknown>>)[key]?.click ===
									'function'
						)
					),
				{ message: 'the Tally action never hydrated its click handler', timeout: 45_000 }
			)
			.toBe(true);
		const popup = page.locator('iframe[data-test-tally]');
		await expect(async () => {
			await tallyAction.click();
			await expect(popup).toBeVisible({ timeout: 2_000 });
		}, 'clicking the action never opened its Tally form with a form id').toPass({
			timeout: 15_000
		});
	}
);
