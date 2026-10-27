// e2e-product: @chat
// e2e-area: @settings
import type { Response, Route } from '@playwright/test';
import { test, expect, type Page } from './helpers/test';
import { freshTestEmail } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { answerShapeEntry, chatEntry, chatPath } from './helpers/chatEntry';
import { captionForRecording, holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { accountButton, accountMenuItem } from './helpers/accountMenu';
import { composerHydrated } from './helpers/composer';
import { startChattingPastWelcome } from './helpers/welcome';
import { testAuthHelpers } from '../testAuth';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// A4 ("I can change how Alpha behaves, and see every setting that applies to me"), steps 1-5. The
// General page is retired: Smooth stream is how every answer streams and long pastes always become an
// attachment, so neither offers a switch. Settings opens on Personalization, lists only sections a
// visitor can use, and keeps About & Privacy and the status page at the foot of its list, each opening
// in a new tab so settings stays where it was. Nothing here is behind a flag, and a guest sees all of it.
//
// Visible copy is asserted with `toContainText`, because the journey gallery's grader reads sampled
// video frames, never the DOM (docs/journeys/README.md).
test(
	'a visitor opening Settings lands on Personalization, with no General page and no streaming or paste switches',
	{ tag: '@A4' },
	async ({ page }) => {
		const nav = page.getByRole('complementary', { name: 'Conversations' });
		await journeyStep(page, 'A4', 1, async () => {
			await page.goto('/chat/settings', { waitUntil: 'commit' });
			await expect(page).toHaveURL(/\/chat\/settings\/personalization$/, { timeout: 15_000 });
			await expect(page.getByRole('heading', { level: 1, name: 'Personalization' })).toBeVisible({
				timeout: 15_000
			});
			await expect(nav.getByRole('link', { name: 'Appearance', exact: true })).toBeVisible();
			await expect(
				nav.getByRole('link', { name: 'General', exact: true }),
				'the retired General page is still in the settings list'
			).toHaveCount(0);
		});

		// An old link or bookmark to General lands on the first section, not a 404.
		await journeyStep(page, 'A4', 2, async () => {
			await page.goto('/chat/settings/application', { waitUntil: 'commit' });
			await expect(page).toHaveURL(/\/chat\/settings\/personalization$/, { timeout: 15_000 });
		});

		await journeyStep(page, 'A4', 3, async () => {
			for (const label of ['Streaming mode', 'Raw stream', 'Paste text directly']) {
				await expect(
					page.locator('body'),
					`"${label}" is still offered, but Smooth stream and paste-as-file are no longer choices`
				).not.toContainText(label);
			}
			await expect(
				page.locator('input[name="streamingMode"], input[name="directPaste"]')
			).toHaveCount(0);
		});

		// About & Privacy and the status page sit at the foot of the settings list, each marked as
		// leaving, and open in a new tab.
		await journeyStep(page, 'A4', 4, async () => {
			const about = nav.getByRole('link', { name: 'About & Privacy (opens in a new tab)' });
			const status = nav.getByRole('link', { name: 'Status page (opens in a new tab)' });
			await expect(about).toBeVisible();
			await expect(about).toHaveAttribute('href', '/privacy-notice');
			await expect(about).toHaveAttribute('target', '_blank');
			await expect(status).toHaveAttribute('href', /status\.aipotluck\.org/);
			await expect(status).toHaveAttribute('target', '_blank');

			const [tab] = await Promise.all([page.context().waitForEvent('page'), about.click()]);
			await tab.waitForLoadState('commit');
			expect(new URL(tab.url()).pathname).toBe('/privacy-notice');
			await tab.close();
			await expect(page, 'opening About & Privacy navigated settings away').toHaveURL(
				/\/chat\/settings\/personalization$/
			);
		});

		// Step 5, CUR-3929, CUR-549 and CUR-3930. Ten structured answer settings are on the page, for a
		// guest as for anyone, each live and each marked Default while unset: nothing greyed out, no
		// "coming soon" placeholder. How Alpha refers to itself reads Machine until the person picks Person.
		await journeyStep(page, 'A4', 5, async () => {
			const answers = page.locator('section', {
				has: page.getByRole('heading', { name: 'How Alpha answers' })
			});
			await expect(answers).toBeVisible({ timeout: 15_000 });
			for (const label of [
				'Tone',
				'Answer length',
				'Suggestions',
				'Answer language',
				'Plain language',
				'How Alpha refers to itself'
			]) {
				await expect(answers, `the "${label}" row is missing`).toContainText(label);
			}
			// Nine fields, each with a Default badge; the preset row has none, it is not a field.
			await expect(answers.locator('[data-answer-default]')).toHaveCount(9);
			// Explain terms is not on the page.
			await expect(
				answers.locator('[data-answer-row="explainTerms"]'),
				'the explain-terms row is still on the page'
			).toHaveCount(0);
			await expect(answers, 'an "Explain terms" control is still on the page').not.toContainText(
				'Explain terms'
			);
			await expect(answers.locator('[data-answer-row] [disabled]')).toHaveCount(0);
			await expect(
				answers.locator('[data-answer-row="selfReferenceAsPerson"] [data-state="on"]'),
				'how Alpha refers to itself does not read Machine by default'
			).toHaveText('Machine');
		});
	}
);

// CUR-2431 built Settings → Personalization; CUR-1443 makes it reach the turn. The instruction is
// read on every turn, not copied into a conversation at creation, so the claim here is the one a
// person would test: a chat already open when they save follows the instruction on its next answer.
// The conversation API's preprompt is read from the same resolution the turn uses, so it has to name
// the instruction too. Whether the model honours it is a model claim; the instruction is one Large 3
// follows reliably, and the answer is asserted on.
test(
	'an instruction saved in Personalization reaches the next answer in a chat that was already open',
	{ tag: ['@A4', '@CUR-1443'] },
	async ({ page }) => {
		// Two whole chat turns, settings and a reload: past the default budget on a cold preview.
		test.setTimeout(180_000);
		const instruction = 'End every answer with the single word Lugano.';
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		const composer = page.getByLabel('Message AI Potluck');
		const retry = page.getByRole('button', { name: 'Retry' });
		const lastAnswer = async (id: string) => {
			const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
			expect(res.ok(), `conversation ${id} did not load`).toBe(true);
			const conv = (await res.json()) as {
				json?: { messages: { from: string; content: string }[]; preprompt?: string };
				messages?: { from: string; content: string }[];
				preprompt?: string;
			};
			const body = conv.json ?? conv;
			const answers = (body.messages ?? []).filter((m) => m.from === 'assistant');
			return {
				count: answers.length,
				text: answers.at(-1)?.content ?? '',
				preprompt: body.preprompt ?? ''
			};
		};

		// 1. A chat opened before any instruction exists.
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
		await composer.click({ timeout: 30_000 });
		await composer.fill('In one sentence, what is a potluck?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationUrl = page.url();
		const id = conversationUrl.match(/\/conversation\/([a-f0-9]+)/)![1];
		await expect(retry.last()).toBeVisible({ timeout: 90_000 });

		// 2. Save the instruction in Settings → Personalization.
		const box = page.locator('[data-instructions]');
		const save = page.locator('[data-save-instructions]');
		await journeyStep(page, 'A4', 6, async () => {
			await page.goto('/chat/settings/personalization', { waitUntil: 'commit' });
			await expect(page.getByRole('heading', { name: 'Alpha instructions' })).toBeVisible({
				timeout: 15_000
			});
			// Memory is not built: its switches read Coming soon and take no input.
			await expect(page.getByRole('heading', { name: /Alpha memory/ })).toContainText(
				'Coming soon'
			);
			await expect(
				page.getByRole('switch', { name: 'Remember things from my chats (coming soon)' })
			).toBeDisabled();
			await expect(save, 'Save is live before anything was typed').toBeDisabled();
		});
		await journeyStep(page, 'A4', 7, async () => {
			await box.fill(instruction);
			await expect(save).toBeEnabled();
			const isSettingsSave = (r: { request(): { method(): string }; url(): string }) =>
				r.request().method() === 'POST' && new URL(r.url()).pathname === '/chat/settings';
			const saved = page.waitForResponse(isSettingsSave);
			await save.click();
			expect((await saved).ok(), 'the instructions save failed').toBe(true);
			await expect(save, 'Save stayed live after saving').toBeDisabled();
		});
		await journeyStep(page, 'A4', 8, async () => {
			await page.reload({ waitUntil: 'commit' });
			await expect(box, 'the saved instruction did not survive a reload').toHaveValue(instruction, {
				timeout: 15_000
			});
			// Journey A4 step 8 is this reloaded box. A bare hold left the box on camera, but the
			// critic could not tell a reload had happened, since a reload looks like no change at all.
			await captionForRecording(
				page,
				'reloaded the page; the saved instruction is still in the box'
			);
		});

		// 3. Back in the SAME chat: the next answer follows the instruction saved after it opened.
		expect(
			(await lastAnswer(id)).preprompt,
			'the open chat does not show the instruction the next turn will use'
		).toContain(instruction);
		await journeyStep(page, 'A4', 9, async () => {
			await page.goto(conversationUrl, { waitUntil: 'commit' });
			await composer.click({ timeout: 30_000 });
			await composer.fill('In one sentence, what is a picnic?');
			await composer.press('Enter');
			// Every finished answer carries a Retry, so the first answer's satisfies `retry.last()` while
			// the second is still running, and the second answer's row is saved empty before its text is.
			// Wait for the second Retry, then for the saved text itself.
			await expect(retry).toHaveCount(2, { timeout: 90_000 });
			await expect
				.poll(async () => (await lastAnswer(id)).text.trim(), {
					message: 'the second answer was never saved with any text',
					timeout: 30_000
				})
				.not.toBe('');
			const { count, text } = await lastAnswer(id);
			expect(count, 'the open chat did not save a second answer').toBe(2);
			expect(
				text.trim().replace(/[.!*_\s]+$/, ''),
				'the next answer in the open chat ignored the instruction saved after it opened'
			).toMatch(/Lugano$/);
		});
	}
);

// The settings group disables SSR, so this page used to arrive as an empty shell and paint
// nothing until the client bundle loaded — most of a second of blank screen on every fresh open,
// which the journey critic flagged. Read the raw server response, not the page: a browser assertion
// passes either way once hydration catches up, so only the HTML itself can tell the two apart.
test(
	'Personalization arrives server-rendered, so a fresh open paints its content without waiting on the client bundle',
	{ tag: ['@A4', '@live'] },
	async ({ request }) => {
		const personalization = chatPath('/settings/personalization');
		const response = await request.get(personalization, { maxRedirects: 0 });
		expect(response.ok(), `GET ${personalization} answered ${response.status()}`).toBe(true);
		const html = await response.text();
		expect(
			html,
			'the server sent an empty shell: the page renders only after the client bundle loads'
		).toContain('Alpha instructions');
		// The HTML carries the visitor's own settings inline, so no shared cache may keep it.
		expect(
			response.headers()['cache-control'] ?? '',
			'a server-rendered page carrying per-visitor settings must not be storable by a shared cache'
		).toMatch(/\bprivate\b.*\bno-store\b|\bno-store\b.*\bprivate\b/);

		// The retired General page answers with a permanent redirect, not a page or a 404.
		const general = await request.get(chatPath('/settings/application'), {
			maxRedirects: 0,
			headers: { accept: 'text/html' }
		});
		expect(general.status(), 'GET the General settings page did not redirect').toBe(308);
		expect(general.headers()['location'] ?? '').toMatch(new RegExp(`${personalization}$`));
	}
);

// At phone width the settings tab row ran off the right edge: the right-hand group of tabs could not
// wrap, and the page clips horizontal overflow, so Storage, Workspace and General were neither
// visible nor reachable by swiping. Every tab has to sit inside the viewport and take a tap.
test.describe('settings tabs at phone width', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	test(
		'at phone width, a signed-in person can see and tap every settings tab',
		{ tag: ['@A4', '@preview-only'] },
		async ({ page }) => {
			const email = freshTestEmail();
			await signInAsFreshUser(page, email);

			// Signed in, the server-rendered settings HTML is this person's own page (their
			// session user is serialized into it), so it must reach them as private, no-store.
			// `page.request` carries this context's session cookie.
			const own = await page.request.get('/chat/settings/personalization');
			expect(own.ok()).toBe(true);
			expect(
				await own.text(),
				'the signed-in HTML does not carry this person’s own session'
			).toContain(email);
			expect(own.headers()['cache-control'] ?? '').toMatch(
				/\bprivate\b.*\bno-store\b|\bno-store\b.*\bprivate\b/
			);

			// At phone width the settings sections are a list on their own page, the one each section's
			// back button returns to.
			await page.goto('/chat/settings?sections', { waitUntil: 'load' });

			const tabs = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
				name: /^(Personalization|Appearance|Data & privacy|Account|Storage|Workspace|Local inference)$/
			});
			await expect(tabs.first()).toBeVisible({ timeout: 20_000 });
			const count = await tabs.count();
			expect(
				count,
				'expected at least the Personalization and Account sections'
			).toBeGreaterThanOrEqual(2);
			for (let i = 0; i < count; i++) {
				const tab = tabs.nth(i);
				const name = await tab.innerText();
				const box = await tab.boundingBox();
				expect(box, `${name} tab has no box`).not.toBeNull();
				expect(
					box!.x + box!.width,
					`the "${name}" tab ends at x=${Math.round(box!.x + box!.width)}, past the 390px screen`
				).toBeLessThanOrEqual(390);
			}

			await tabs.filter({ hasText: 'Appearance' }).tap();
			await expect(page).toHaveURL(/\/settings\/appearance/);
			await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
		}
	);

	// Settings from the account menu opened straight onto General, so on a phone the list
	// with Personalization sat one tap behind a "Settings" back button. A phone now lands on the list.
	test(
		'CUR-3601: at phone width, Settings from the account menu opens the section list, and Personalization is one tap from it',
		{ tag: ['@A4', '@CUR-3601', '@preview-only'] },
		async ({ page }) => {
			test.setTimeout(120_000);
			await signInAsFreshUser(page, freshTestEmail());
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await page.goto(chatEntry(), { waitUntil: 'commit' });

			await expect(async () => {
				// A tap that landed but navigated slower than the check below leaves the drawer open on
				// Settings, where "Open sidebar" no longer exists, so a retry must stop here, not tap again.
				if (new URL(page.url()).pathname.includes('/settings')) return;
				// The phone drawer keeps its account button laid out but off-screen while closed, so a
				// visibility check passes on a button no finger can reach. Open the drawer until it is in view.
				const inView = await expect(accountButton(page))
					.toBeInViewport({ timeout: 1_000 })
					.then(
						() => true,
						() => false
					);
				if (!inView)
					await page.getByRole('button', { name: 'Open sidebar' }).tap({ timeout: 2_000 });
				await (await accountMenuItem(page, 'Settings', { timeout: 5_000 })).tap();
				await expect(page).toHaveURL(/\/settings/, { timeout: 2_000 });
			}, 'the account menu never opened Settings').toPass({ timeout: 45_000 });

			const list = page.getByRole('navigation', { name: 'Settings sections' });
			await expect(list, 'Settings opened somewhere other than the section list').toBeVisible({
				timeout: 20_000
			});
			await expect(page).toHaveURL(/\/settings\?sections/);
			await list.getByRole('link', { name: 'Personalization' }).tap();
			await expect(page).toHaveURL(/\/settings\/personalization/);
			await expect(page.getByRole('heading', { name: 'Personalization' })).toBeVisible();
		}
	);
});

// The nav's Settings link points at bare /settings, which used to render the dialog with
// an empty body and only then redirect, from a layout $effect, to the first section. The second
// navigation loaded while the empty body sat on screen: 2.16s on one click against develop. The
// redirect lives in the route's load now, so the browser never commits the bare URL. Every committed
// URL is recorded, because the empty body's lifetime is timing-dependent and a screenshot can miss
// it, but a URL the browser committed cannot be missed.
test(
	'the nav Settings link lands on Personalization without ever committing the empty bare /settings page',
	{ tag: ['@A4', '@live'] },
	async ({ page, request }) => {
		const bare = new RegExp(`^${chatPath('/settings')}/?$`);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const committed: string[] = [];
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) committed.push(new URL(frame.url()).pathname);
		});

		// Re-resolved on every attempt. A single click() pins the element `:visible` matched first; when
		// the Welcome dialog's handler closes the dialog, the layout swaps which Settings link is shown,
		// and that pinned element stays hidden for the whole timeout ("element is not
		// visible" after "locator handler has finished").
		// Settings lives in the account menu at the foot of the sidebar.
		await expect(async () => {
			const settingsItem = page.getByRole('menuitem', { name: 'Settings' });
			if (!(await settingsItem.isVisible())) {
				await page.locator('[data-account-trigger]:visible').first().click({ timeout: 3_000 });
			}
			await settingsItem.click({ timeout: 3_000 });
		}).toPass({ timeout: 20_000 });
		await expect(page.getByRole('heading', { level: 1, name: 'Personalization' })).toBeVisible({
			timeout: 15_000
		});
		await expect(page).toHaveURL(/\/settings\/personalization$/);
		expect(
			committed.filter((p) => bare.test(p)),
			`the Settings click committed bare /settings first, which paints an empty dialog body: ${committed.join(' -> ')}`
		).toEqual([]);

		// A fresh open gets a plain server redirect rather than a page that redirects itself later. The
		// Accept header matters: without text/html SvelteKit hands a GET to the sibling +server.ts,
		// which has only POST, and answers 405 whether or not the page redirects.
		const hard = await request.get(chatPath('/settings'), {
			maxRedirects: 0,
			headers: { accept: 'text/html' }
		});
		expect(hard.status(), 'GET bare /settings did not redirect from the server').toBe(307);
		expect(hard.headers()['location'] ?? '').toMatch(
			new RegExp(`${chatPath('/settings/personalization')}$`)
		);
	}
);

// A4 steps 10-12 (CUR-2627). The chat window opens dark, and Settings → Appearance's Mode control
// switches it. This is the chat window's own mode (chatTheme.ts); the site outside the chat has no
// dark mode. A choice that took on screen and reverted on reload would
// look exactly like one that saved, so the window's mode is read again after the reload.
test(
	'a visitor can switch the chat window to light from Appearance, and it stays light after a reload',
	{ tag: '@A4' },
	async ({ page }) => {
		const chatWindow = page.locator('.ds-root[data-mode]').first();
		await page.goto('/chat/settings/personalization', { waitUntil: 'load' });
		await expect(chatWindow).toHaveAttribute('data-mode', 'dark', { timeout: 15_000 });

		const modeRow = page.locator('section', { has: page.getByRole('heading', { name: 'Mode' }) });
		await journeyStep(page, 'A4', 10, async () => {
			await page.getByRole('link', { name: 'Appearance' }).first().click();
			await page.waitForURL(/\/chat\/settings\/appearance$/, { timeout: 15_000 });
			await expect(modeRow).toContainText('Light, dark, or follow your system.');
			// Journey A4 step 10 is this page as it opens, with Mode on the dark the window shows.
			await expect(
				modeRow.locator('[data-state="on"]'),
				'Mode does not show Dark selected while the chat window is dark'
			).toHaveText('Dark');
			await holdForRecording(page);
		});

		await journeyStep(page, 'A4', 11, async () => {
			await modeRow.getByText('Light', { exact: true }).click();
			await expect(
				chatWindow,
				'choosing Light under Mode did not turn the chat window light'
			).toHaveAttribute('data-mode', 'light', { timeout: 5_000 });
		});

		await journeyStep(page, 'A4', 12, async () => {
			await page.reload({ waitUntil: 'load' });
			await expect(
				chatWindow,
				'the chat window went back to dark after a reload: the Light choice was not kept'
			).toHaveAttribute('data-mode', 'light', { timeout: 15_000 });
			// A first visit to the chat opens the welcome splash over it, and the row's screen is the chat.
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await page.goto(chatEntry(), { waitUntil: 'load' });
			await expect(
				chatWindow,
				'the chat itself is not light after choosing Light in Appearance'
			).toHaveAttribute('data-mode', 'light', { timeout: 15_000 });
			// A click on the composer is what gives the handler its turn if the splash is up.
			await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
			await captionForRecording(page, 'back in the chat: the window is still light');
		});
	}
);

// Dismissing Welcome to Alpha saves the seen mark with one request, and a reload landing while it
// was in flight cancelled it, so the intro came back on the next load. The dismissal is held here for
// 1.5 s and the page reloads at once, which makes that race certain. The contract is what the person
// sees: once the held save is let go, the next load shows no intro. Playwright reports no
// requestfinished for a keepalive request whose page has gone, so the spec asserts the outcome and
// records whether the held request could still be sent.
test(
	'CUR-2574: dismissing Welcome to Alpha and reloading at once still keeps the intro down on the next load',
	{ tag: ['@A4', '@CUR-2574', '@preview-only'] },
	async ({ page }, testInfo) => {
		test.setTimeout(90_000);
		const context = page.context();
		let released: Promise<boolean> | undefined;
		await context.route(/\/chat\/settings$/, async (route) => {
			if (route.request().method() !== 'POST' || released) return route.fallback();
			if (!(route.request().postData() ?? '').includes('welcomeModalSeen')) return route.fallback();
			released = new Promise((resolve) => setTimeout(resolve, 1_500)).then(() =>
				route.continue().then(
					() => true,
					() => false
				)
			);
			await released;
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await expect(
			welcomeDialog,
			'a fresh guest got no Welcome to Alpha intro to dismiss'
		).toBeVisible({
			timeout: 30_000
		});
		await welcomeDialog.getByRole('button', { name: /start chatting/i }).click();
		await page.reload({ waitUntil: 'commit' });

		await expect
			.poll(() => released !== undefined, {
				message: 'dismissing the intro sent no save',
				timeout: 10_000
			})
			.toBe(true);
		const sent = await released!;
		testInfo.annotations.push({
			type: 'CUR-2574',
			description: sent
				? 'the held save was sent after the reload'
				: 'the held save was dropped by the reload'
		});

		// The save is released, not yet written, so each try reloads; without the fix it never lands.
		await expect(async () => {
			await page.reload({ waitUntil: 'domcontentloaded' });
			// Hidden only counts once the page could have opened it.
			await composerHydrated(page, { timeout: 20_000 });
			await expect(welcomeDialog).toBeHidden({ timeout: 3_000 });
		}, 'Welcome to Alpha came back for a guest who had dismissed it: the reload cancelled the seen mark').toPass(
			{
				timeout: 45_000
			}
		);
	}
);

// These contracts were written against General's streaming and paste controls. When General was
// retired they moved to the haptics switch on Appearance, the switch that page still saves to the
// server. It renders only on a touch device, so the block emulates one. The CUR-1649 check (a saved
// switch is not faded before hydration) did not move: this switch renders only in the browser, so
// there is no server-rendered switch to look at.
test.describe('settings saves, on the haptics switch', () => {
	test.use({ hasTouch: true });

	const isSettingsSave = (r: { request(): { method(): string }; url(): string }) =>
		r.request().method() === 'POST' && new URL(r.url()).pathname === '/chat/settings';
	const hapticsSwitch = (scope: Page) =>
		scope.getByRole('switch', { name: 'Haptic feedback', exact: true });

	// Each save used to start its own 3s timer to hide the "Saved" pill, so a change made
	// within 3s of another was hidden by the earlier timer and never got a confirmation of its own. The
	// page clock is installed so the pill's timers are driven exactly rather than slept through.
	test(
		'a second setting changed soon after a first still gets its own Saved confirmation, held for its full time',
		{ tag: '@A4' },
		async ({ page }) => {
			await page.clock.install();
			await page.goto('/chat/settings/appearance', { waitUntil: 'commit' });
			const toggle = hapticsSwitch(page);
			await expect(toggle).toBeVisible({ timeout: 15_000 });
			// Hydrated once the switch takes input: neither disabled nor inside an inert wrapper (CUR-2009, CUR-1649).
			await expect
				.poll(
					() => toggle.evaluate((el) => !el.hasAttribute('disabled') && !el.closest('[inert]')),
					{ timeout: 15_000 }
				)
				.toBe(true);
			const saved = page.getByRole('status').filter({ hasText: 'Saved' });
			// Nothing saved yet, so no confirmation: the pill below is the save's own.
			await expect(saved).toBeHidden();

			const firstSave = page.waitForResponse(isSettingsSave);
			await toggle.click();
			await page.clock.runFor(400);
			expect((await firstSave).ok(), 'the first haptics save failed').toBe(true);
			await expect(saved).toBeVisible();

			// Two seconds on, well inside the first confirmation's three.
			await page.clock.runFor(2_000);
			const secondSave = page.waitForResponse(isSettingsSave);
			await toggle.click();
			await page.clock.runFor(400);
			expect((await secondSave).ok(), 'the second haptics save failed').toBe(true);

			// Past the first save's three seconds, inside the second's: the pill is the second save's now.
			await page.clock.runFor(1_500);
			await expect(
				saved,
				'the first save’s timer hid the second save’s confirmation'
			).toBeVisible();

			await page.clock.runFor(2_000);
			await expect(saved).toBeHidden();

			// Two toggles from on: the server keeps the second, so the reload reads on again.
			await page.reload({ waitUntil: 'commit' });
			await expect(toggle, 'the second save did not stick').toHaveAttribute(
				'aria-checked',
				'true',
				{
					timeout: 15_000
				}
			);
		}
	);

	// What the deleted streaming and paste test promised for its two controls, for the switch that
	// remains: a choice made through it survives a reload.
	test(
		'a visitor can turn haptics off from Appearance, and it stays off after a reload',
		{ tag: '@A4' },
		async ({ page }) => {
			await page.goto('/chat/settings/appearance', { waitUntil: 'commit' });
			const toggle = hapticsSwitch(page);
			await expect(toggle, 'haptics should start on, its default').toHaveAttribute(
				'aria-checked',
				'true',
				{ timeout: 15_000 }
			);
			const save = page.waitForResponse(isSettingsSave);
			await expect(async () => {
				await toggle.click({ timeout: 2_000 });
				await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 1_000 });
			}, 'the switch never took a click').toPass({ timeout: 15_000 });
			expect((await save).ok(), 'the haptics save failed').toBe(true);
			await expect(
				page.getByRole('status').filter({ hasText: 'Saved' }),
				'the change saved without a confirmation'
			).toBeVisible({ timeout: 5_000 });

			await page.reload({ waitUntil: 'commit' });
			await expect(toggle, 'haptics came back on after a reload').toHaveAttribute(
				'aria-checked',
				'false',
				{ timeout: 15_000 }
			);
		}
	);

	// Every settings write used to post the whole local store, and the server wrote a default
	// for every field a body left out. So a second tab, opened before the first one's change, reverted
	// that change the moment it saved anything of its own. Two pages in one context share one session,
	// which is exactly what two tabs are.
	test(
		'a setting saved in one tab survives a different setting saved from a second tab opened earlier',
		{ tag: '@A4' },
		async ({ context }) => {
			const instruction = 'Answer in short paragraphs.';
			const open = async (path: string) => {
				const tab = await context.newPage();
				await tab.goto(path, { waitUntil: 'commit' });
				return tab;
			};

			// Both tabs load first, so the second holds haptics still on when it saves.
			const first = await open('/chat/settings/appearance');
			const second = await open('/chat/settings/personalization');
			await expect(hapticsSwitch(first)).toHaveAttribute('aria-checked', 'true', {
				timeout: 15_000
			});
			const instructions = second.getByRole('textbox').first();
			await expect(instructions).toBeEditable({ timeout: 15_000 });

			const hapticsSaved = first.waitForResponse(isSettingsSave);
			await hapticsSwitch(first).click();
			expect((await hapticsSaved).ok(), 'the haptics save failed').toBe(true);

			await instructions.fill(instruction);
			const instructionsSaved = second.waitForResponse(isSettingsSave);
			await second.locator('[data-save-instructions]').click();
			expect((await instructionsSaved).ok(), 'the instructions save failed').toBe(true);

			await first.reload({ waitUntil: 'commit' });
			await expect(
				hapticsSwitch(first),
				'the second tab’s save turned haptics back on in the first'
			).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
			await second.reload({ waitUntil: 'commit' });
			await expect(second.getByRole('textbox').first()).toHaveValue(instruction, {
				timeout: 15_000
			});
			await second.goto('/chat/settings/appearance', { waitUntil: 'commit' });
			await expect(
				hapticsSwitch(second),
				'the second tab still shows the haptics value it opened with'
			).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
		}
	);
});

// Five structured answer settings on Personalization, each on the account. A choice saves at
// once through one serial lane (answerSaveLane.ts), so what the page shows is what the next turn reads.
// Only the deterministic claims live here: that a choice is stored, shown after a reload, reset to
// Default, and read on a second device. Whether a model then follows the choice is the live probe's
// claim (evals/inspect_tasks/answer_preferences.py).
test.describe('how Alpha answers (CUR-3929)', () => {
	const isSettingsSave = (r: { request(): { method(): string }; url(): string }) =>
		r.request().method() === 'POST' && new URL(r.url()).pathname === '/chat/settings';
	const ROWS = [
		'tone',
		'answerLength',
		'suggestions',
		'answerLanguage',
		'plainLanguage',
		// CUR-549
		'answerFormat',
		'emojis',
		// CUR-3930
		'selfReferenceAsPerson',
		'showServing'
	] as const;
	const row = (scope: Page, key: string) => scope.locator(`[data-answer-row="${key}"]`);
	const pressed = (scope: Page, key: string) => row(scope, key).locator('[data-state="on"]');
	const defaultBadge = (scope: Page, key: string) =>
		scope.locator(`[data-answer-default="${key}"]`);
	const resetLink = (scope: Page, key: string) => scope.locator(`[data-answer-reset="${key}"]`);
	const saveError = (scope: Page) => scope.locator('[data-answer-error]');
	const savedPill = (scope: Page) => scope.getByRole('status').filter({ hasText: 'Saved' });
	const storedSettings = async (scope: Page) => {
		const res = await scope.request.get('/chat/api/v2/user/settings');
		expect(res.ok(), `GET /chat/api/v2/user/settings answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as { json?: Record<string, unknown> } & Record<string, unknown>;
		return (body.json ?? body) as Record<string, unknown>;
	};
	// A fresh signed-in person, as helpers/session.ts mints one, with the id kept so a second browser
	// context can be signed in as the same account.
	const mintUser = async (page: Page) => {
		const auth = await testAuthHelpers();
		const user = auth.createUser({ email: freshTestEmail() });
		user.name = '';
		await auth.saveUser(user);
		await page.context().addCookies(await auth.getCookies({ userId: user.id }));
		return user.id;
	};
	const openPersonalization = async (scope: Page) => {
		await scope.goto('/chat/settings/personalization', { waitUntil: 'commit' });
		await expect(scope.getByRole('heading', { name: 'How Alpha answers' })).toBeVisible({
			timeout: 15_000
		});
		// Hydrated once a toggle takes input.
		await expect
			.poll(() => pressed(scope, 'tone').evaluate((el) => !el.closest('[inert]')), {
				timeout: 15_000
			})
			.toBe(true);
	};
	/** Pick a toggle in a three-option row and wait for its own save to answer. */
	const choose = async (scope: Page, key: string, label: string) => {
		const saved = scope.waitForResponse(isSettingsSave);
		await row(scope, key).getByText(label, { exact: true }).click();
		const res = await saved;
		expect(res.ok(), `saving ${key} = ${label} answered ${res.status()}`).toBe(true);
	};
	/** A request the test holds open until it says so. */
	const gate = () => {
		let release!: () => void;
		const opened = new Promise<void>((r) => (release = r));
		return { opened, release };
	};
	/** Observe every settings POST in order, hold or fail each one as told, and record each response as
	 *  it completes, so a status is read from its own request. While a request is held, a second one
	 *  cannot have been answered, so `sent.length` says whether the lane waited. */
	const tapSaves = async (
		page: Page,
		fate: (n: number) => { gate?: Promise<void>; status?: number } = () => ({})
	) => {
		const sent: { body: Record<string, unknown>; at: number }[] = [];
		const responses: { status: number; at: number }[] = [];
		const handler = async (route: Route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			const n = sent.push({ body: JSON.parse(route.request().postData() ?? '{}'), at: Date.now() });
			const { gate: held, status } = fate(n);
			if (held) await held;
			if (status) await route.fulfill({ status, body: 'held back by the test' });
			else await route.continue();
		};
		const onResponse = async (r: Response) => {
			if (!isSettingsSave(r)) return;
			await r.finished();
			responses.push({ status: r.status(), at: Date.now() });
		};
		await page.route('**/chat/settings', handler);
		page.on('response', onResponse);
		return {
			sent,
			responses,
			bodies: () => sent.map((x) => x.body),
			/** The statuses of the first `n` settings responses, once that many have completed. */
			until: async (n: number) => {
				await expect
					.poll(() => responses.length, {
						timeout: 15_000,
						message: `waiting for ${n} settings responses`
					})
					.toBeGreaterThanOrEqual(n);
				return responses.slice(0, n).map((r) => r.status);
			},
			stop: async () => {
				page.off('response', onResponse);
				await page.unroute('**/chat/settings', handler);
			}
		};
	};

	test(
		'a signed-in person sets tone and length, each saves at once, survives a reload, resets to Default and reaches a second device',
		{ tag: ['@A4', '@CUR-3929'] },
		async ({ page, browser }) => {
			test.setTimeout(120_000);
			const userId = await mintUser(page);

			await journeyStep(page, 'A4', 13, async () => {
				await openPersonalization(page);
				const section = page.locator('section', {
					has: page.getByRole('heading', { name: 'How Alpha answers' })
				});
				await expect(section).toContainText(
					'These apply from your next message, in new chats and ones already open. Agent mode follows only the answer language.'
				);
				for (const key of ROWS) {
					await expect(
						defaultBadge(page, key),
						`${key} does not read Default on a fresh account`
					).toBeVisible();
				}
				await expect(pressed(page, 'tone')).toHaveText('Neutral');
				await expect(pressed(page, 'answerLength')).toHaveText('Normal');
				await expect(pressed(page, 'selfReferenceAsPerson')).toHaveText('Machine');
				await expect(page.getByRole('switch', { name: 'Suggestions' })).toHaveAttribute(
					'aria-checked',
					'true'
				);
				await expect(page.getByRole('switch', { name: 'Plain language' })).toHaveAttribute(
					'aria-checked',
					'false'
				);
			});

			await journeyStep(page, 'A4', 14, async () => {
				await choose(page, 'tone', 'Plain');
				await expect(savedPill(page), 'the choice saved without a confirmation').toBeVisible({
					timeout: 5_000
				});
				await choose(page, 'answerLength', 'Short');
				await expect(defaultBadge(page, 'tone')).toHaveCount(0);
				await expect(defaultBadge(page, 'answerLength')).toHaveCount(0);
				const stored = await storedSettings(page);
				expect(stored.tone, 'the tone was not stored').toBe('plain');
				expect(stored.answerLength, 'the length was not stored').toBe('short');
			});

			await journeyStep(page, 'A4', 15, async () => {
				await page.reload({ waitUntil: 'commit' });
				await expect(pressed(page, 'tone'), 'the tone did not survive a reload').toHaveText(
					'Plain',
					{
						timeout: 15_000
					}
				);
				await expect(pressed(page, 'answerLength')).toHaveText('Short');
				await expect(defaultBadge(page, 'tone')).toHaveCount(0);
				await expect(defaultBadge(page, 'answerLength')).toHaveCount(0);
			});

			await journeyStep(page, 'A4', 16, async () => {
				// The reset's request is held, so the badge's return is the store's, not the server's.
				const first = gate();
				const tap = await tapSaves(page, (n) => (n === 1 ? { gate: first.opened } : {}));
				await resetLink(page, 'tone').click();
				await expect(
					defaultBadge(page, 'tone'),
					'the Default badge waited for the request'
				).toBeVisible({
					timeout: 500
				});
				expect(tap.responses, 'the badge returned only once the request had answered').toHaveLength(
					0
				);
				first.release();
				expect((await tap.until(1))[0], 'the reset failed').toBe(200);
				await tap.stop();
				expect(
					(await storedSettings(page)).tone ?? null,
					'the reset left a tone on the row'
				).toBeNull();
				await page.reload({ waitUntil: 'commit' });
				await expect(defaultBadge(page, 'tone'), 'the reset did not survive a reload').toBeVisible({
					timeout: 15_000
				});
				await expect(pressed(page, 'tone')).toHaveText('Neutral');
			});

			await journeyStep(page, 'A4', 17, async () => {
				// A second device: a second context, signed in with a SECOND minted session for the same
				// user, not the first context's cookies.
				const auth = await testAuthHelpers();
				const other = await browser.newContext();
				try {
					await other.addCookies(await auth.getCookies({ userId }));
					const second = await other.newPage();
					await openPersonalization(second);
					await expect(
						pressed(second, 'answerLength'),
						'the length did not reach a second device'
					).toHaveText('Short', { timeout: 15_000 });
					await expect(defaultBadge(second, 'tone')).toBeVisible();
				} finally {
					await other.close();
				}
			});

			await test.step('picking the default value itself unsets the row, so it reads Default, not Reset', async () => {
				const tap = await tapSaves(page);
				await choose(page, 'answerLength', 'Normal');
				await tap.stop();
				expect(tap.bodies()).toEqual([{ answerLength: null }]);
				await expect(defaultBadge(page, 'answerLength')).toBeVisible();
				await expect(resetLink(page, 'answerLength')).toHaveCount(0);
				expect(
					(await storedSettings(page)).answerLength ?? null,
					'picking Normal stored it'
				).toBeNull();
			});
		}
	);

	// One preset writes exactly its five fields in one request through the same lane; one later
	// change to any of them reads Custom; a field outside the list keeps its own value. The receipt
	// toggle hides which model answered and where it ran, under the answer and in X-ray, and nothing
	// else: the "How this was made" link stays, since X-ray is the person's to open.
	test(
		'a preset sets several rows in one save, a later change reads Custom, and the receipt toggle hides the model and host',
		{ tag: ['@A4', '@CUR-549'] },
		async ({ page }) => {
			// A preset, a reload, one whole chat turn and two more settings saves: past the default budget.
			test.setTimeout(180_000);
			await mintUser(page);
			const presetRow = page.locator('[data-answer-row="preset"]');
			const presetNote = page.locator('[data-answer-preset-note]');
			const servingSwitch = page.getByRole('switch', { name: 'Show the model and host' });

			await journeyStep(page, 'A4', 18, async () => {
				await openPersonalization(page);
				await expect(presetRow).toHaveAttribute('data-answer-preset', 'neutral');
				await expect(presetRow.locator('[data-state="on"]')).toHaveText('Neutral');
				await expect(presetRow).toContainText(
					'A preset sets tone, length, format, plain language and emojis.'
				);
				const tap = await tapSaves(page);
				await presetRow.getByText('Plain', { exact: true }).click();
				expect(await tap.until(1)).toEqual([200]);
				await tap.stop();
				expect(
					tap.bodies(),
					'the preset did not go out as one body over exactly its five fields'
				).toEqual([
					{
						tone: 'plain',
						answerLength: 'short',
						answerFormat: 'auto',
						plainLanguage: true,
						emojis: 'never'
					}
				]);
				await expect(presetRow).toHaveAttribute('data-answer-preset', 'plain');
				await expect(pressed(page, 'tone')).toHaveText('Plain');
				await expect(pressed(page, 'answerLength')).toHaveText('Short');
				await expect(page.getByRole('switch', { name: 'Plain language' })).toHaveAttribute(
					'aria-checked',
					'true'
				);
				// The fields a preset never touches keep their Default badge.
				for (const key of ['suggestions', 'answerLanguage', 'showServing']) {
					await expect(defaultBadge(page, key), `${key} was touched by the preset`).toBeVisible();
				}
				const stored = await storedSettings(page);
				expect(stored).toMatchObject({ tone: 'plain', answerLength: 'short', plainLanguage: true });
				// The settings GET always carries every answer field, an unset one as null (superjson writes
				// undefined as null), so the key is present either way: the value is the claim.
				expect(stored.answerLanguage ?? null, 'the preset wrote the language').toBeNull();
			});

			await journeyStep(page, 'A4', 19, async () => {
				await choose(page, 'answerLength', 'Detailed');
				await expect(presetRow).toHaveAttribute('data-answer-preset', 'custom');
				await expect(presetRow.locator('[data-state="on"]')).toHaveCount(0);
				await expect(presetNote).toContainText('Custom');
				const stored = await storedSettings(page);
				expect(stored.tone, 'the length change took the tone with it').toBe('plain');
				expect(stored.answerLength).toBe('detailed');
				await page.reload({ waitUntil: 'commit' });
				await expect(presetRow, 'Custom did not survive a reload').toHaveAttribute(
					'data-answer-preset',
					'custom',
					{ timeout: 15_000 }
				);
				await expect(pressed(page, 'tone')).toHaveText('Plain');
				await expect(pressed(page, 'answerLength')).toHaveText('Detailed');
			});

			// An answer, so the receipt has something to hide.
			const composer = page.getByLabel('Message AI Potluck');
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await welcomeDialog.getByRole('button', { name: /start chatting/i }).click();
			});
			const footer = () => page.locator('[data-answer-footer]').last();
			await journeyStep(page, 'A4', 20, async () => {
				await page.goto(answerShapeEntry(), { waitUntil: 'commit' });
				await composer.click({ timeout: 30_000 });
				await composer.fill('In one sentence, what is a potluck?');
				await composer.press('Enter');
				await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
				await expect(footer().locator('[data-how-made]')).toBeVisible({ timeout: 90_000 });
				await expect(
					footer().locator('[data-provenance="line"]'),
					'the answer named no model and host while the receipt is on'
				).toBeVisible();
			});
			const conversationUrl = page.url();

			await journeyStep(page, 'A4', 21, async () => {
				await openPersonalization(page);
				await expect(servingSwitch).toHaveAttribute('aria-checked', 'true');
				const off = page.waitForResponse(isSettingsSave);
				await servingSwitch.click();
				expect((await off).ok(), 'the receipt toggle did not save').toBe(true);
				await expect(defaultBadge(page, 'showServing')).toHaveCount(0);
				expect((await storedSettings(page)).showServing).toBe(false);

				await page.goto(conversationUrl, { waitUntil: 'commit' });
				await expect(
					footer().locator('[data-how-made]'),
					'the X-ray link went with the name'
				).toBeVisible({
					timeout: 30_000
				});
				await expect(footer().locator('[data-how-made]')).toHaveAttribute('data-serving', 'hidden');
				await expect(
					footer().locator('[data-provenance="line"]'),
					'the model and host still show under the answer'
				).toHaveCount(0);
				await footer().locator('[data-how-made]').click();
				const receipt = page.locator('[data-answer-receipt]');
				await expect(receipt.locator('[data-provenance="hidden"]')).toBeVisible({
					timeout: 15_000
				});
				await expect(receipt).toContainText('You chose not to show which model wrote this answer');

				// Back on: the name and host return under the answer.
				await openPersonalization(page);
				const on = page.waitForResponse(isSettingsSave);
				await servingSwitch.click();
				expect((await on).ok()).toBe(true);
				await page.goto(conversationUrl, { waitUntil: 'commit' });
				await expect(
					footer().locator('[data-provenance="line"]'),
					'the model and host did not return'
				).toBeVisible({
					timeout: 30_000
				});
			});
		}
	);

	// Plan 4.5: one request in flight at a time, in the order the person made the changes; failure
	// recovers per key to the value the server last took, and the error stays until that key saves.
	test(
		'answer-preference saves go out one at a time in order, coalesce while one is in flight, and recover per key when one fails',
		{ tag: ['@A4', '@CUR-3929', '@preview-only'] },
		async ({ page }) => {
			test.setTimeout(150_000);
			await mintUser(page);
			await openPersonalization(page);
			await choose(page, 'tone', 'Plain');

			await test.step('a reset then a choice reach the server in that order, the second only after the first answered', async () => {
				const first = gate();
				const tap = await tapSaves(page, (n) => (n === 1 ? { gate: first.opened } : {}));
				await resetLink(page, 'tone').click();
				await row(page, 'tone').getByText('Formal', { exact: true }).click();
				await expect(pressed(page, 'tone')).toHaveText('Formal');
				expect(tap.sent, 'the second change went out while the first was in flight').toHaveLength(
					1
				);
				first.release();
				expect(await tap.until(2)).toEqual([200, 200]);
				await tap.stop();
				expect(tap.bodies()).toEqual([{ tone: null }, { tone: 'formal' }]);
				await expect(pressed(page, 'tone')).toHaveText('Formal');
				expect((await storedSettings(page)).tone, 'the reset overtook the later choice').toBe(
					'formal'
				);
			});

			await test.step('three changes made while one request is held go out as one coalesced body', async () => {
				const first = gate();
				const tap = await tapSaves(page, (n) => (n === 1 ? { gate: first.opened } : {}));
				await row(page, 'tone').getByText('Plain', { exact: true }).click();
				await row(page, 'answerLength').getByText('Short', { exact: true }).click();
				await row(page, 'tone').getByText('Neutral', { exact: true }).click();
				await row(page, 'answerLength').getByText('Detailed', { exact: true }).click();
				expect(tap.sent).toHaveLength(1);
				first.release();
				expect(await tap.until(2)).toEqual([200, 200]);
				await tap.stop();
				// Neutral is Alpha's default, so picking it unsets the row as a reset does.
				expect(tap.bodies()).toEqual([{ tone: 'plain' }, { tone: null, answerLength: 'detailed' }]);
				const stored = await storedSettings(page);
				expect(stored.tone ?? null, 'picking the default stored it').toBeNull();
				expect(stored.answerLength).toBe('detailed');
			});

			await test.step('with every save failing, a queued second pick survives the first failure and both end on the saved Neutral with the error shown', async () => {
				// Neutral is the saved value from the step above. Plain is held and then fails while Formal
				// waits behind it; Formal then fails too.
				const first = gate();
				const second = gate();
				const tap = await tapSaves(page, (n) => ({
					gate: n === 1 ? first.opened : second.opened,
					status: 500
				}));
				await row(page, 'tone').getByText('Plain', { exact: true }).click();
				await row(page, 'tone').getByText('Formal', { exact: true }).click();
				expect(tap.sent).toHaveLength(1);
				first.release();
				expect(await tap.until(1)).toEqual([500]);
				await expect(
					pressed(page, 'tone'),
					'the first failure overwrote the queued Formal'
				).toHaveText('Formal');
				second.release();
				expect(await tap.until(2)).toEqual([500, 500]);
				await tap.stop();
				expect(tap.bodies()).toEqual([{ tone: 'plain' }, { tone: 'formal' }]);
				await expect(
					pressed(page, 'tone'),
					'a second failed save left Formal on screen'
				).toHaveText('Neutral');
				await expect(saveError(page)).toBeVisible();
				expect((await storedSettings(page)).tone ?? null).toBeNull();
			});

			await test.step('when only the first save fails, the newer pick for the same field still goes out and succeeds, and the error clears', async () => {
				const first = gate();
				const tap = await tapSaves(page, (n) =>
					n === 1 ? { gate: first.opened, status: 500 } : {}
				);
				await row(page, 'tone').getByText('Plain', { exact: true }).click();
				await row(page, 'tone').getByText('Formal', { exact: true }).click();
				expect(tap.sent).toHaveLength(1);
				first.release();
				expect(await tap.until(2)).toEqual([500, 200]);
				await tap.stop();
				expect(tap.bodies()).toEqual([{ tone: 'plain' }, { tone: 'formal' }]);
				await expect(pressed(page, 'tone'), 'the failure of Plain overwrote Formal').toHaveText(
					'Formal'
				);
				await expect(savedPill(page)).toBeVisible({ timeout: 5_000 });
				await expect(saveError(page), 'an error shows although the newer value saved').toBeHidden();
				expect((await storedSettings(page)).tone).toBe('formal');
			});

			await test.step('when the first save fails on one field, that field goes back and stays in error while a pending other field still saves', async () => {
				await choose(page, 'tone', 'Neutral');
				await choose(page, 'answerLength', 'Normal');
				const first = gate();
				const tap = await tapSaves(page, (n) =>
					n === 1 ? { gate: first.opened, status: 500 } : {}
				);
				await row(page, 'tone').getByText('Plain', { exact: true }).click();
				await row(page, 'answerLength').getByText('Short', { exact: true }).click();
				expect(tap.sent).toHaveLength(1);
				first.release();
				expect(await tap.until(2)).toEqual([500, 200]);
				expect(tap.bodies()).toEqual([{ tone: 'plain' }, { answerLength: 'short' }]);
				await expect(
					pressed(page, 'tone'),
					'the failed tone did not go back to Neutral'
				).toHaveText('Neutral');
				await expect(pressed(page, 'answerLength')).toHaveText('Short');
				await expect(
					saveError(page),
					"the length's success hid the tone's error before the tone saved"
				).toBeVisible();
				let stored = await storedSettings(page);
				expect(stored.tone ?? null).toBeNull();
				expect(stored.answerLength).toBe('short');
				// The error clears once the failed key itself saves.
				await row(page, 'tone').getByText('Plain', { exact: true }).click();
				expect(await tap.until(3)).toEqual([500, 200, 200]);
				await tap.stop();
				await expect(saveError(page), 'the error stayed after the failed key saved').toBeHidden();
				stored = await storedSettings(page);
				expect(stored.tone).toBe('plain');
			});
		}
	);
});
