// e2e-product: @chat
// e2e-area: @settings @turn
import { test, expect } from './helpers/test';
import { holdForRecording } from './helpers/recording';
import { chatEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// F5 ("Alpha looks and behaves the same everywhere") — "How Alpha looks, one design system":
// type sizes, spacing, colours, icons and settings screens all coming from one place
// (CUR-507).
//
// WRITTEN AGAINST CUR-972's "Done when", NOT ITS "Tests". The ticket for this
// ("Chat, settings and workspace look and behave like one product") carries both, and the two are
// different kinds of thing. Its Tests are moderated sessions — sit someone who has never seen Alpha
// in front of it and record where they look first. That is real and it is UX research; it cannot
// gate a merge and nothing here pretends to stand in for it. The Done-when list is checkable, and
// the subset of it reachable signed out without a workspace is what this walks:
//
//   • every control that changes how an answer is produced is in one place   → steps 2 and 3
//   • moving between chatting and settings without relearning where things are → steps 1, 4, 6
//
// The three Done-when items about workspaces (which one you are in, admin versus member, the three
// switches) need an org and an admin account. They belong with A8's spec, and saying so here is
// what keeps this card from reading as coverage of the whole ticket.
//
// WHY IT ASSERTS TOKENS AND NOT PIXELS. A screenshot diff on this journey would go red on every
// deliberate design change, which is the opposite of useful while a design system is landing. What
// "one design system" means mechanically is that the surfaces read their colour and type from the
// same custom properties rather than from hardcoded values — so the assertion is that the tokens
// resolve, and that two surfaces built at different times resolve them to the same value.
//
// Vercel's preview toolbar is not part of that one design system, and the journey critic kept
// grading it as ours (CUR-2148). It is off for previews in the Vercel project's settings now, and
// this file deliberately sends no `x-vercel-skip-toolbar` header: the absence assertion at the end of
// the first test is what goes red if the setting is ever turned back on, and an opt-out here would
// hide exactly that.
test(
	'chat and settings are the same product: one control group, one type scale, one set of colours, one section heading style (CUR-3954)',
	{ tag: '@F5' },
	async ({ page }) => {
		test.setTimeout(90_000);
		// Same overlay hazard every chat-entry spec in this suite handles: the welcome dialog mounts
		// on an async settings load, so it can arrive after first paint and make the page inert.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		// Step 1. The chat, as a first-time visitor reaches it.
		const composer = page.getByLabel('Message AI Potluck');
		await journeyStep(page, 'F5', 1, async () => {
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			await expect(composer).toBeVisible({ timeout: 30_000 });
		});

		// Step 2. Every control that changes an answer sits with the composer rather than scattered
		// across the screen. Named controls, because F3's sibling claim is that they are named — and
		// because a class-based selector would pass on a control that no screen reader can find.
		//
		// READ FROM THE CHAT SURFACE, NOT FROM <html> (CUR-1974). The chat window scopes `.dark` onto
		// its own card (chatTheme.ts) and never onto <html>, and the settings dialog is portalled onto
		// <body>, outside that card, taking its dark palette only from Modal's own `dark` prop. Reading
		// `document.documentElement` would be wrong: there both screens resolve the LIGHT `:root`
		// values, so it would compare light to light and stay green through a navy modal (CUR-1702). The
		// element read here is the one that actually paints the chat's background.
		const chatSurface = page.locator('.chat-root', { has: composer });
		const chatTokens = await chatSurface.evaluate((el) => {
			const s = getComputedStyle(el);
			return {
				paper: s.getPropertyValue('--ap-paper').trim(),
				ink: s.getPropertyValue('--ap-ink').trim(),
				rule: s.getPropertyValue('--ap-rule').trim(),
				text3: s.getPropertyValue('--ap-text-3').trim(),
				background: s.backgroundColor
			};
		});
		expect(
			Object.entries(chatTokens).filter(([, v]) => v === ''),
			'one or more design-system custom properties resolved to nothing on the chat screen, so whatever is painted there is coming from somewhere other than the design system'
		).toEqual([]);

		const settingsDialog = page.locator('main');
		// Step 3. Into settings, the other surface the demo puts side by side with it.
		await journeyStep(page, 'F5', 2, async () => {
			await page.goto('/chat/settings', { waitUntil: 'commit' });
			await page.waitForURL(/\/settings/, { timeout: 30_000 });

			// Step 4. The settings screens a person moves between, reachable and named.
			//
			// APPLICATION, NOT ACCOUNT, and the difference is the whole point of this persona.
			// The persona above is signed OUT, and signed out the settings dialog offers exactly
			// two entries: Models and Application. Account appears only once there is an account to
			// manage. Asserting it here would make a signed-in precondition the spec never establishes.
			//
			// The accessible name rather than the visible label: the word "Application" is itself on
			// CUR-972's list of things that read wrong to a person, so this pins reachability and
			// deliberately not the wording, which is free to be fixed without breaking the journey.
			await expect(
				page.getByRole('link', { name: 'Personalization' }),
				'the settings nav did not offer the Personalization entry within 30s, so the screens the demo moves between are not reachable from each other'
			).toBeVisible({ timeout: 30_000 });

			// Step 4b. The panel has actually rendered its controls (CUR-1809).
			//
			// Everything above this line is satisfied before the panel body exists. The nav link lives in
			// the dialog's sidebar, which mounts first, and the token read below comes off `:root`
			// via getComputedStyle, which resolves at first paint whether or not anything is painted. So a
			// settings screen that rendered an entirely empty panel would pass this spec green — while the
			// spec's own name promises "one control group". The guarantee would be
			// weaker than the name.
			//
			// Asserting here closes both halves at once. The spec starts testing what it is named for,
			// and the page dwells on the populated state long enough for the recording to photograph it —
			// the graders read sampled video frames, never the DOM, so a state that flashes past is
			// invisible to them (docs/journeys/README.md).
			//
			// Roles rather than copy, for the same reason step 4 above gives: the labels here are on
			// CUR-972's list of wording that may yet change, and a spec that goes red on a rename is a
			// spec somebody deletes. Settings opens on Personalization: its
			// instruction box and the switches beside it are the control group. Settings is a page in the
			// app's main column now (Claude Desktop's shape), not a dialog.
			await expect(
				settingsDialog.getByRole('heading', { level: 1, name: 'Personalization' }),
				'the settings page never titled its panel within 30s, so whatever is open is not the Personalization screen'
			).toBeVisible({ timeout: 30_000 });
			await expect(
				settingsDialog.getByRole('textbox').first(),
				'the settings panel rendered no text box, so the body is empty and the "one control group" this journey claims cannot be compared against chat'
			).toBeVisible({ timeout: 30_000 });
			await expect(
				settingsDialog.getByRole('switch').first(),
				'the settings panel rendered no toggle, so the body is empty and the "one control group" this journey claims cannot be compared against chat'
			).toBeVisible({ timeout: 30_000 });

			// Step 5. The same tokens, resolved to the same values, and the same colour actually painted.
			// This is the whole claim: two surfaces built months apart painting from one source. A mismatch
			// here is the July-screenshot failure the demo exists to show is over.
			//
			// Both halves are needed. The tokens catch a dialog that lost its dark scope; `background`
			// catches one still in dark scope but painting something other than the token, which is
			// exactly CUR-1702 — `dark:bg-gray-800` on Modal.svelte, a navy the tokens never mention.
			const settingsTokens = await settingsDialog.evaluate((el) => {
				const s = getComputedStyle(el);
				return {
					paper: s.getPropertyValue('--ap-paper').trim(),
					ink: s.getPropertyValue('--ap-ink').trim(),
					rule: s.getPropertyValue('--ap-rule').trim(),
					text3: s.getPropertyValue('--ap-text-3').trim(),
					background: s.backgroundColor
				};
			});
			expect(
				settingsTokens,
				`chat and settings resolved the design system's own properties to different values, so they are two products wearing one palette. chat: ${JSON.stringify(chatTokens)} settings: ${JSON.stringify(settingsTokens)}`
			).toEqual(chatTokens);
		});

		// Step 3, walked. A person moves between settings pages, and the step compares them, so the
		// recording needs a second page to compare against. With only one, the grader
		// files the step as claimed but not seen (CUR-2259). Signed out, the pages on
		// offer are Personalization, Appearance and Data & privacy; Appearance is the one built from
		// different controls (a radio group of themes), which is where drift would show. The settings
		// nav in the side rail is how a person moves between pages.
		// A settings section heading is the same kind of thing on every page, so it is drawn the
		// same way. Both pages must match, not a bold sans title on one and a small mono label on the other (CUR-3954).
		const sectionHeading = () =>
			settingsDialog
				.getByRole('heading', { level: 2 })
				.first()
				.evaluate((h) => {
					const s = getComputedStyle(h);
					return [s.fontFamily, s.fontSize, s.fontWeight, s.textTransform].join(' / ');
				});
		await journeyStep(page, 'F5', 3, async () => {
			const onPersonalization = await sectionHeading();
			await holdForRecording(page);
			await page
				.getByRole('complementary', { name: 'Conversations' })
				.getByRole('link', { name: 'Appearance' })
				.click();
			await expect(
				settingsDialog.getByRole('heading', { level: 1, name: 'Appearance' }),
				'the Appearance entry did not open the Appearance page, so a person cannot move between settings pages'
			).toBeVisible({ timeout: 30_000 });
			await expect(
				settingsDialog.getByRole('radiogroup').first(),
				'the Appearance page rendered no theme choices, so there is no second page to compare against Personalization'
			).toBeVisible({ timeout: 30_000 });
			expect(
				await sectionHeading(),
				'Personalization and Appearance draw their section headings in two different styles, so the pages read as built from different parts'
			).toBe(onPersonalization);
			await holdForRecording(page);
		});

		// Step 6. Back to the conversation, which is the move a person makes after changing a
		// setting. Settings being a place you can leave is half of "without relearning where things
		// are"; a dead end is the failure. Through the settings nav's own way out, since the browser's
		// back button would now land on Personalization.
		await journeyStep(page, 'F5', 6, async () => {
			await page.getByRole('link', { name: 'Back to app' }).first().click();
			await expect(
				page.getByLabel('Message AI Potluck'),
				'going back from settings did not return to a composer, so a person who opens settings mid-conversation has no way back to what they were doing'
			).toBeVisible({ timeout: 30_000 });
		});

		// Checked last, after two page loads have had time to run the toolbar's own script (CUR-2148).
		await expect(
			page.locator('vercel-live-feedback'),
			'Vercel’s preview toolbar is on screen, and the journey critic grades it as our own UI'
		).toHaveCount(0);
	}
);

// PHONE WIDTH IS SET HERE, NOT INSIDE THE TEST, AND THE REASON IS THE RECORDING (CUR-1764).
//
// Playwright fixes a video's frame size when the CONTEXT is created and never changes it again, so
// `page.setViewportSize()` mid-test does not resize the recording — it scales the page down into the
// frame it already has and fills the rest with flat mid-grey, `rgb(128, 128, 128)`. With
// a full-bleed `position: absolute; inset: 0` panel, resizing a 1280x720 context
// to 390x844 leaves the panel occupying columns 2-205 of an 800x450 frame. Seventy-four per cent of
// every frame after the resize was recorder padding that never existed in the browser.
//
// The PM critic reads frames. It files that padding as a product defect (CUR-1764) —
// "a narrow fixed-width card floating in the center with large blank gray margins on both sides",
// "a small round icon control sitting half outside the right edge, floating into the grey background
// area" — about the frames, correctly. `test.use` applies the viewport at context
// creation instead, which records a 368x800 portrait frame with zero padding
// columns. Nothing about what this test EXERCISES changes: a desktop Chrome UA at 390px wide, which
// is what the resize produced too.
//
// `e2e/scenarios/**` forbids `page.setViewportSize` in eslint.config.js for this reason. Reach for
// `test.use({ viewport })` or a project entry.
test.describe('phone width', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test(
		'at phone width the chat still offers a composer and nothing runs off the side',
		{ tag: '@F5' },
		async ({ page }) => {
			test.setTimeout(60_000);
			// CUR-972's Done-when is silent on width, but its test 5 is "all of the above in a phone
			// browser" and the demo list's design-system item is a production claim about how Alpha
			// looks, which is mostly how it looks on a phone.
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});

			await journeyStep(page, 'F5', 5, async () => {
				await page.goto(chatEntry(), { waitUntil: 'commit' });
				const composer = page.getByLabel('Message AI Potluck');
				await expect(composer).toBeVisible({ timeout: 30_000 });

				// The composer is in the server HTML under the welcome dialog, so it is "visible"
				// before anyone can use it. Ending there left the graded recording on the dialog, and the
				// grader could not see the step. Walk it instead: the dialog closes, a person types, and the
				// send control that appears sits inside the 390px screen. Nothing is sent.
				await expect(welcomeDialog, 'the welcome dialog never closed at phone width').toBeHidden();
				await composer.fill('Does this fit on a phone?');
				const send = page.getByRole('button', { name: 'Send message' });
				await expect(send).toBeEnabled();
				const box = await send.boundingBox();
				expect(
					box && box.x + box.width,
					'the send button runs past the right edge of a 390px screen'
				).toBeLessThanOrEqual(390);

				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth
				);
				expect(
					overflow,
					`the page is ${overflow}px wider than the viewport at 390px, so a phone user scrolls sideways to read it`
				).toBeLessThanOrEqual(1);
			});
		}
	);
});
