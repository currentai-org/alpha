// e2e-product: @chat @site
// e2e-area: @turn
// Nothing in this repo ran an accessibility checker before this file. Two real pages to
// start: the home/map landing and the chat entry point, both reachable with no sign-in or flag
// override, so this gate needs no extra scaffolding to stay live. The chat's Text 3 colour
// (~50% white) is borderline WCAG AA for reading content; the chat scan is the one that would catch
// that line being crossed.
import { test, expect } from './helpers/test';
import { assertNoSeriousA11yViolations } from './helpers/a11y';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';
import { installCannedReplies } from './helpers/faultInjection';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

test.describe('accessibility', () => {
	test('home page has no serious/critical violations', { tag: '@live' }, async ({ page }) => {
		await page.goto('/', { waitUntil: 'load' });
		await assertNoSeriousA11yViolations(page, 'home');
	});

	test('chat entry page has no serious/critical violations', async ({ page }) => {
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await assertNoSeriousA11yViolations(page, 'chat-entry');
	});

	// The map's pages set small grey text (tab labels, captions, roster tags, scores), which has to
	// hold WCAG AA's 4.5:1; at 50–60% opacity it measured 1.7–3.98:1.
	for (const [name, path] of [
		['gap-map', '/map/gap-map'],
		['dataset', '/map/dataset'],
		['org', '/org/nvidia'],
		['product', '/product/helixdb'],
		['updates', '/updates']
	] as const) {
		test(`${name} page has no serious/critical violations`, async ({ page }) => {
			// The dataset page is ~8.8 MB of HTML and ~30,000 elements, and axe's scan of it alone ran past
			// the default 90 s on loaded CI runners (CUR-4447). The verdict is unchanged; only the wait is.
			if (name === 'dataset') test.setTimeout(240_000);
			await page.goto(path, { waitUntil: 'load' });
			await assertNoSeriousA11yViolations(page, name);
		});
	}

	// Proves the gate can actually go red: inject a real,
	// unambiguous violation — an <img> with no alt text or role, axe's `image-alt` rule at critical
	// impact — into a live page, and assert the SAME helper the two tests above use reports it. A
	// future change that quietly weakens assertNoSeriousA11yViolations (a loosened tag list, an
	// impact filter that stops matching, an allowlist that swallows everything) fails this test
	// instead of silently shipping a gate that can no longer find anything.
	test('self-test: detects an injected image-alt violation', async ({ page }) => {
		await page.goto('/', { waitUntil: 'load' });
		await page.evaluate(() => {
			const img = document.createElement('img');
			img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
			img.setAttribute('data-a11y-self-test', 'true');
			document.body.appendChild(img);
		});
		await expect(assertNoSeriousA11yViolations(page, 'self-test-injected')).rejects.toThrow(
			/image-alt/
		);
	});
});

// The privacy notice's four-column partner table scrolls sideways at phone width, and a scroller
// nothing can focus can't be scrolled from the keyboard (axe's scrollable-region-focusable).
test.describe('accessibility at phone width', () => {
	test.use({ viewport: { width: 390, height: 844 } });
	test('privacy notice page has no serious/critical violations', async ({ page }) => {
		await page.goto('/privacy-notice', { waitUntil: 'load' });
		const scrolling = page.locator('table[tabindex="0"]');
		await expect(
			scrolling.first(),
			'no table on the page scrolls sideways at 390px'
		).toBeAttached();
		await assertNoSeriousA11yViolations(page, 'privacy-notice-phone');
	});
});

// The sidebar's per-conversation actions button (the only way to Delete one conversation) was
// display:none at desktop width until mouse hover, so a keyboard user could never Tab to it. It now
// shows while its row holds focus. The conversation is created through the API with no message, so
// the test costs no model turn.
test.describe('keyboard reach at desktop width', () => {
	test.use({ viewport: { width: 1280, height: 800 } });
	// The welcome is modal, but Tab used to walk through the composer hidden behind it and Escape did
	// nothing, so the first screen of Alpha could not be used without a mouse.
	test(
		'a first-time guest can stay inside the welcome with Tab and leave it with Escape for the message box @CUR-4259',
		{ tag: ['@P5', '@F3'] },
		async ({ page }) => {
			await page.goto(chatEntry(), { waitUntil: 'load' });
			const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await expect(welcome, 'no welcome on a fresh guest visit').toBeVisible({ timeout: 30_000 });
			// The welcome opens once the page is live and puts focus on its way forward, the tour.
			await expect(
				welcome.getByRole('button', { name: /take the tour/i }),
				'focus did not start on Take the tour'
			).toBeFocused({ timeout: 30_000 });

			for (let i = 1; i <= 12; i++) {
				await page.keyboard.press('Tab');
				const where = await page.evaluate(() => {
					const el = document.activeElement;
					const dialog = document.querySelector('[data-welcome]');
					const name = el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 60) ?? '';
					return {
						inside: Boolean(el && dialog?.contains(el)),
						what:
							el && el !== document.body
								? `<${el.tagName.toLowerCase()}> "${name}"`
								: 'the page body'
					};
				});
				expect(
					where.inside,
					`Tab ${i} moved focus out of the welcome, to ${where.what}, a control the welcome covers`
				).toBe(true);
			}

			await page.keyboard.press('Escape');
			await expect(welcome, 'Escape did not close the welcome').toBeHidden();
			await expect(
				page.getByLabel('Message AI Potluck'),
				'after Escape, focus is not in the message box'
			).toBeFocused();
		}
	);

	test(
		'at desktop width, Tab from a sidebar conversation reaches its actions button and Delete',
		{ tag: ['@preview-only'] },
		async ({ page }) => {
			await signInAsFreshUser(page);

			const models = (await (await page.request.get('/chat/api/models')).json()) as {
				id?: string;
				name?: string;
			}[];
			const created = await page.request.post('/chat/conversation', {
				data: { model: models[0]?.id ?? models[0]?.name }
			});
			expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
			const { conversationId } = (await created.json()) as { conversationId: string };

			await page.goto(chatEntry(), { waitUntil: 'load' });
			const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await welcome
				.getByRole('button', { name: /start chatting/i })
				.click({ timeout: 8_000 })
				.catch(() => {});
			const open = page.getByRole('button', { name: 'Open sidebar' });
			if (await open.isVisible()) await open.click();

			// The nav renders twice (desktop rail and mobile drawer); `:visible` picks this viewport's.
			const link = page.locator(`a[href$="/conversation/${conversationId}"]:visible`);
			await expect(link).toBeVisible({ timeout: 20_000 });
			await link.focus();
			// This fails intermittently and no run uploads a trace, so each
			// way it can fail says where focus was: lost before the Tab, or moved somewhere else by it.
			await expect(link, 'the conversation link lost focus before Tab was pressed').toBeFocused();
			await page.keyboard.press('Tab');
			const actions = link
				.locator('xpath=..')
				.getByRole('button', { name: 'Conversation actions' });
			try {
				await expect(actions).toBeFocused();
			} catch (err) {
				const focused = await page.evaluate(() => {
					const el = document.activeElement;
					if (!el || el === document.body) return 'the page body';
					const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? '';
					const d = el.closest('[role="dialog"]');
					const labelledBy = d?.getAttribute('aria-labelledby');
					const dialog = d
						? d.getAttribute('aria-label') ||
							(labelledBy && document.getElementById(labelledBy)?.textContent?.trim()) ||
							'unnamed'
						: '';
					return `<${el.tagName.toLowerCase()}> "${name}"${dialog ? ` inside dialog "${dialog}"` : ''}`;
				});
				throw new Error(
					`Tab from the conversation link did not land on its actions button; focus is on ${focused}\n${String(err)}`,
					{ cause: err }
				);
			}
			await page.keyboard.press('Enter');
			await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
		}
	);
});

// The "?" beside an answer's provenance trace was announced as "Why this matters" but opened a
// dialog titled "Where it's weak", so a screen-reader user was promised one thing and handed another.
test(
	"the provenance trace's ? button is named for the dialog it opens",
	{ tag: '@F3' },
	async ({ page }) => {
		// Sends a real turn and waits up to 90s for it, after up to 60s of setup (CUR-1633's budget check).
		test.setTimeout(180_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of France in one short sentence.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const trigger = page.getByRole('button', { name: "Where it's weak", exact: true }).first();
		await expect(
			trigger,
			'no control beside the answer is named for the weak-spots dialog'
		).toBeVisible({
			timeout: 90_000
		});
		await trigger.click();
		await expect(
			page.getByRole('dialog').getByRole('heading', { name: "Where it's weak" })
		).toBeVisible();
	}
);
