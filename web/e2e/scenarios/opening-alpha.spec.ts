// e2e-product: @chat @site
// e2e-area: @provenance @turn
import { test, expect } from './helpers/test';
import { CHAT_ENTRY, chatEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { installCannedReplies } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// F3 ("What people see and use when they open Alpha").
//
// The only journey in this suite with nothing typed in it. Every other one asks a question and
// judges the answer; this judges the page as it arrives, because that is the state a visitor
// sees over someone's shoulder.
//
// WHY NO `addLocatorHandler` HERE, unlike every sibling spec. The others register a handler so the
// welcome dialog gets dismissed out of the way of the thing they are actually testing. Here the
// dialog IS step 1, so auto-dismissing it would skip the assertion — the handler would fire, the
// test would pass, and nothing would have checked that a first-time visitor is told what this is.
//
// WHAT IS ASSERTED AS PRESENT RATHER THAN AS A VALUE. The empty state names the model (or says Auto
// picks one per message), says X-ray on
// each answer shows where it ran (it names no host before a turn, CUR-2364), and states the retention
// rule. The model and retention copy differ by deployment, so the spec checks the page says these
// things at all, before the visitor has typed anything, which is the ordering that makes it an
// honesty claim.

test(
	'a first-time visitor is told what Alpha is, what runs it, and how to leave, before typing anything',
	{ tag: ['@F3', '@live'] },
	async ({ page }) => {
		await page.goto(chatEntry(), { waitUntil: 'domcontentloaded' });

		// Step 1. The welcome says what this is and offers a way past itself. Found by its heading
		// rather than its accessible name, because the name is one of the things checked below.
		const welcome = page
			.getByRole('dialog')
			.filter({ has: page.getByRole('heading', { level: 1, name: 'Welcome to Alpha' }) });
		const enter = welcome.getByRole('button', { name: /start chatting/i });
		const welcomeCopy = await journeyStep(page, 'F3', 1, async () => {
			await expect(
				welcome,
				'no welcome appears, so a first-time visitor meets an empty box with no statement of what this product is or is not'
			).toBeVisible({ timeout: 30_000 });
			// What a screen reader announces for the dialog is the heading a sighted visitor reads.
			// A separate label that appears nowhere on screen would break that.
			const heading = (await welcome.getByRole('heading', { level: 1 }).innerText()).trim();
			await expect(
				welcome,
				`the welcome dialog is announced under a name other than its visible heading "${heading}"`
			).toHaveAccessibleName(heading);

			const welcomeCopy = ((await welcome.textContent()) ?? '').toLowerCase();
			expect(
				welcomeCopy.length,
				'the welcome is effectively empty, so it costs a visitor a dismissal and tells them nothing'
			).toBeGreaterThan(80);

			// The credits row names only makers whose models this deployment serves (CUR-2565): production
			// serves Apertus alone, so a BSC credit there names a part no visitor can use.
			const servedIds: string[] = await page.evaluate(async () => {
				const res = await fetch('/chat/api/v2/models');
				const body = JSON.stringify(await res.json());
				return [...body.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
			});
			const credits =
				(await welcome.getByRole('region', { name: 'Made with open parts from' }).textContent()) ??
				'';
			if (credits.includes('Barcelona Supercomputing Center')) {
				expect(
					servedIds.some((id) => /alia/i.test(id)),
					`the welcome credits BSC while this deployment serves no ALIA model (served: ${servedIds.join(', ')})`
				).toBe(true);
			}

			await expect(
				enter,
				'the welcome has no way out, so the first interaction with Alpha is being stuck in a modal'
			).toBeVisible({ timeout: 10_000 });
			return welcomeCopy;
		});
		const emptyState = await journeyStep(page, 'F3', 2, async () => {
			await enter.click();
			await expect(welcome).toBeHidden({ timeout: 10_000 });

			// Step 2. The uncomfortable facts arrive before the useful ones. A product trying to impress
			// puts these in a footer; putting them on the empty page is the argument F3 is about.
			const body = page.locator('body');
			await expect(
				page.getByLabel('Message AI Potluck'),
				'the composer never becomes available, so nothing below could be reached'
			).toBeVisible({ timeout: 30_000 });

			// A language promise ("picks an open model built for it") is Auto routing, so the welcome may make
			// it only where Auto is offered. The model pill names "How Alpha chooses" exactly when the
			// `auto-routing` flag is on (CUR-2565). The welcome leaves the features to the guided tour
			// and makes no such promise, so only the "never where Auto is off" half is asserted.
			const pillLabel =
				(await page
					.locator('[data-model-pill]')
					.first()
					.getAttribute('aria-label', { timeout: 30_000 })) ?? '';
			const autoOffered = pillLabel.includes('How Alpha chooses');
			// Offered is not chosen: a model link (`chatEntry()` under the gallery's prod profile) picks its
			// model, and the pill then names it instead of Auto (CUR-4021).
			const autoChosen = autoOffered && /^Model: Auto\b/.test(pillLabel);
			if (!autoOffered)
				expect(
					welcomeCopy.includes('speaks your language'),
					'the welcome promises a model picked for your language while Auto routing is off, so nothing in the chat does what it says'
				).toBe(false);

			const emptyState = ((await body.innerText()) ?? '').toLowerCase();
			// With Auto chosen, no model is chosen until a message is sent, so the line
			// says Alpha picks one per message instead of naming one (ChatIntroduction.svelte).
			const servingLine = emptyState.match(
				/(running on\s+\S+|alpha picks a model for each message)[^\n]*/
			)?.[0];
			expect(
				servingLine,
				`the empty state does not say what will answer, so the first honest thing about this product arrives only after a question. Page read: ${emptyState.slice(0, 600)}`
			).toMatch(autoChosen ? /alpha picks a model for each message/ : /running on\s+\S+/);
			expect(
				servingLine,
				'the empty state does not say where to see where each answer ran, which is the sovereignty claim this product leads with'
				// CUR-2364: before a turn, a host is a forecast that pooling and fallbacks make wrong, so the
				// line points at X-ray's "Where it ran", read from each answer's routing record
				// (xray-where-it-ran.spec.ts checks that half).
			).toMatch(/x-ray on each answer shows (where it ran|which one ran, and where)/);
			expect(
				emptyState,
				'the empty state does not state what happens to the conversation, so retention is something a visitor discovers rather than agrees to'
			).toMatch(/deleted automatically|don’t train AI/);
			return emptyState;
		});

		// Step 3. The session's own footprint, in units. A figure with no unit is not a disclosure.
		expect(
			emptyState,
			'the session footprint carries no unit, so the number cannot be read as a cost'
		).toMatch(/\d+\s*wh/);

		// Step 4. The exit is one tap from the first screen. "Forget everything" lives in Settings → Data &
		// privacy, and the Private pill under the message box, which a first-time visitor sees, links there.
		await journeyStep(page, 'F3', 4, async () => {
			await page.getByRole('button', { name: 'Where your message goes' }).click();
			await expect(
				page.getByRole('link', { name: 'Data & privacy' }),
				'nothing on the first screen leads to deleting everything, so leaving requires finding a settings page a first-time visitor has no reason to open'
			).toBeVisible({ timeout: 15_000 });
		});
		await page.keyboard.press('Escape');

		// Step 5. Examples that show what it is for, rather than a blank box that tests the visitor.
		const prompts = page.getByRole('button').filter({ hasText: /\?|\./ });
		expect(
			await prompts.count(),
			'the empty page offers no example prompts, so a visitor who does not already know what to ask is tested rather than shown'
		).toBeGreaterThan(0);
	}
);

test(
	'every control around the composer is named, and the x-ray view is offered by name',
	// @F6 too: f6-where-alpha-runs.md's step 4 is finding the x-ray control, and its grader only
	// receives footage from tests carrying its own tag (CUR-2245).
	{ tag: ['@F3', '@F6'] },
	async ({ page }) => {
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		// Step 6. An icon-only control with no accessible name is a control whose meaning has to be
		// discovered by pressing it — which for a destructive or a mode-changing button is the whole
		// problem. This checks naming, not correctness of the names: A6 already pins the two that
		// work in opposite directions.
		await journeyStep(page, 'F3', 6, async () => {
			const unnamed = await page.evaluate(() => {
				const named = (b: HTMLButtonElement) =>
					(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()
						.length > 0;
				return [...document.querySelectorAll('button')]
					.filter((b) => (b as HTMLButtonElement).offsetParent !== null)
					.filter((b) => !named(b as HTMLButtonElement))
					.map((b) => (b as HTMLButtonElement).outerHTML.slice(0, 120));
			});
			expect(
				unnamed,
				`some visible controls have no accessible name at all, so their meaning can only be learned by pressing them: ${unnamed.join(' ~~ ')}`
			).toEqual([]);
		});

		// "X-ray, provenance and energy work in Alpha" — the x-ray view is offered by name on the
		// first screen rather than being something a visitor has to already know exists.
		await expect(
			page.getByRole('button', { name: /x-ray/i }).first(),
			'nothing on the first screen offers the x-ray view, so the provenance story is only discoverable by someone who was told about it'
		).toBeVisible({ timeout: 15_000 });

		await expect(
			page.getByRole('button', { name: /^This session:/ }).first(),
			'the session footprint cannot be opened for detail, so the headline figure is the whole disclosure'
		).toBeVisible({ timeout: 15_000 });
	}
);

// The front door. Every other F3 test starts at /chat, which a first-time visitor only reaches by
// being handed the URL. This one starts where they do, at the home page, and follows the link a
// visitor would follow: "Try Alpha" straight into chat, since the home page does not route through the
// /alpha landing. Found by where it leads rather than by its wording, which is CMS copy
// editors change, and followed into a new tab when the CMS sets one. Done means reachable from
// `/` through the UI (the merge bar for user-visible changes); the "one product" ask is CUR-972.
// Preview-only: on www a page load of /chat 308s to alpha.aipotluck.org.
test(
	'a first-time visitor gets from the home page into Alpha and a message they send is answered',
	{ tag: ['@F3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await page.goto('/', { waitUntil: 'domcontentloaded' });

		const intoChat = page.locator('main a[href="/chat"]').first();
		await expect(
			intoChat,
			'the home page has no link into the chat, so a visitor cannot find it from the front door'
		).toBeVisible({ timeout: 30_000 });
		// The CMS link may open in a new tab; the visitor carries on in whichever tab the chat opened in.
		const opensNewTab = (await intoChat.getAttribute('target')) === '_blank';
		const [chat] = await Promise.all([
			opensNewTab ? page.context().waitForEvent('page') : Promise.resolve(page),
			intoChat.click()
		]);
		await chat.waitForURL(/\/chat\/?(\?.*)?$/, { timeout: 30_000 });

		// Step 1 again, reached the way a visitor reaches it: the welcome, and a way past it.
		const welcome = chat.getByRole('dialog', { name: 'Welcome to Alpha' });
		await journeyStep(chat, 'F3', 1, async () => {
			await expect(
				welcome,
				'arriving from the home page, the chat skipped its welcome'
			).toBeVisible({
				timeout: 30_000
			});
		});
		await welcome.getByRole('button', { name: /start chatting/i }).click();
		await installCannedReplies(chat);

		const composer = chat.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			`F3 front door ${Date.now()}. In one short sentence, what is bread made from?`
		);
		await composer.press('Enter');
		await chat.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = chat.locator('[data-message-role="assistant"]').last();
		// Retry renders once the turn is over, answered or not; the checks after it say which.
		await expect(
			answer.getByRole('button', { name: 'Retry' }),
			'the first message never finished'
		).toBeVisible({
			timeout: 90_000
		});
		await expect(
			answer.getByText('Response was interrupted'),
			'the first answer was cut off'
		).toHaveCount(0);
		await expect(
			answer.getByText(/No answer was produced/),
			'the first message got no answer'
		).toHaveCount(0);
		await expect(answer.locator('.prose').first(), 'the first answer is empty').toContainText(
			/\w{3,}/
		);
	}
);

// The empty screen's line names the picked model (CUR-2364). A host clause would be a forecast from
// config that pooling and fallbacks can make wrong, so the line names no host for any pick and points
// at X-ray, which says where each answer ran from its own record. The pick here is made in the
// composer (CUR-967 asks for choosing the model from the chat).
// The rendered line must not run words together, as "Apertus1.570B" does on a recording frame (CUR-3045); it must
// carry the picker's name with its spaces, followed by the full stop that ends it.
test(
	'the empty screen names the picked model and no forecast host, and changes when the pick does',
	{ tag: ['@F3', '@preview-only', '@CUR-3045'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		// The pick is walked on the plain list production shows; with Auto on the list sits one level
		// down, in a submenu (CUR-3923).
		await setFlagOverrides(context, baseURL!, { 'auto-routing': false });
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		// /chat, never chatEntry(): with SCENARIO_MODEL set that is /chat/models/<id>, and the test below
		// covers picking on a model's own page (CUR-3295). This spec walks every pick from /chat.
		await page.goto(CHAT_ENTRY, { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		const trigger = page.getByRole('button', { name: /^Model:/ });
		await trigger.click({ timeout: 30_000 });
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const offered = await options.evaluateAll((els) =>
			els.map((el) => ({
				id: (el as HTMLElement).dataset.modelId ?? '',
				name: ((el as HTMLElement).innerText.split('\n')[0] ?? '').trim()
			}))
		);
		await page.keyboard.press('Escape');
		expect(
			offered.length,
			'only one model is offered, so there is no pick to follow'
		).toBeGreaterThan(1);

		const landing = page.locator('[data-chat-landing]');
		const lines: Record<string, string> = {};
		await journeyStep(page, 'F3', 2, async () => {
			for (const { id, name } of offered) {
				await trigger.click();
				await page.locator(`[data-model-id="${id}"]`).click();
				await expect(trigger).toContainText(name, { timeout: 10_000 });
				const line = landing.getByText(/^Running on /);
				await expect(line, `the empty screen did not follow the pick to ${name}`).toContainText(
					name,
					{
						timeout: 10_000
					}
				);
				lines[id] = (await line.innerText()).trim();
				expect(lines[id], `the empty screen ran ${name}'s name together`).toContain(
					`Running on ${name}.`
				);
			}
		});
		test.info().annotations.push({ type: 'serving lines', description: JSON.stringify(lines) });

		// No pick names a host before its first answer (CUR-2364); each points at X-ray instead.
		for (const [id, line] of Object.entries(lines)) {
			expect(line, `${id}'s empty screen forecasts a host`).not.toMatch(/\bserved\b/i);
			expect(line, `${id}'s empty screen does not point at X-ray`).toContain(
				'X-ray on each answer shows where it ran.'
			);
		}
	}
);

// A model's own page (/chat/models/<id>, from the models list or a shared link) must not keep its
// model from the URL for good: a pick in the composer has to relabel the picker, the empty screen's
// line and the new chat. The URL's model is only the starting pick (CUR-3295).
test(
	"on a model's own page, a pick in the composer moves the empty screen and the chat to the picked model",
	{ tag: ['@F3', '@preview-only', '@CUR-3295'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'auto-routing': false });
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		const pageModel = 'mistral-large-2610';
		await page.goto(`${CHAT_ENTRY}/models/${pageModel}`, { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		const trigger = page.getByRole('button', { name: /^Model:/ });
		await trigger.click({ timeout: 30_000 });
		const options = page.locator('[data-model-id]');
		await expect(options.first()).toBeVisible({ timeout: 10_000 });
		const offered = await options.evaluateAll((els) =>
			els.map((el) => ({
				id: (el as HTMLElement).dataset.modelId ?? '',
				name: ((el as HTMLElement).innerText.split('\n')[0] ?? '').trim()
			}))
		);
		const other = offered.find((o) => o.id !== pageModel && o.name);
		if (!other)
			throw new Error(`no model besides ${pageModel} is offered: ${JSON.stringify(offered)}`);
		await page.locator(`[data-model-id="${other.id}"]`).click();
		await expect(trigger).toContainText(other.name, { timeout: 10_000 });

		await expect(
			page.locator('[data-chat-landing]').getByText(/^Running on /),
			`the empty screen stayed on the page's model after picking ${other.name}`
		).toContainText(`Running on ${other.name}.`, { timeout: 10_000 });

		await composer.fill('Reply with one word: hello.');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the conversation back answered ${res.status()}`).toBe(true);
		const stored = ((await res.json()) as { json?: { model?: string } }).json?.model;
		expect(stored, `the new chat was created on ${stored}, not the picked ${other.id}`).toBe(
			other.id
		);

		// The turn is credited to the picked model either way: a badge on its answer, or, when that model
		// is out of capacity (CUR-3982), the busy or timed-out notice
		// that names it. Either is the honest outcome; what this test guards is which model gets named.
		const badge = page.getByRole('button', { name: /^How this answer was made — / }).last();
		const busy = page.getByRole('main').getByRole('alert').last();
		await expect(
			badge.or(busy),
			'the first answer never showed its provenance or a notice naming its model'
		).toBeVisible({ timeout: 150_000 });
		// Two words, so "Mistral Medium" is told apart from the page's Mistral Large.
		const family = other.name.split(' ').slice(0, 2).join(' ');
		const answered = await badge.isVisible();
		const credit = answered ? await badge.getAttribute('aria-label') : await busy.innerText();
		// A notice in place of an answer is honest only if it lets the person try again.
		if (!answered)
			await expect(
				busy.getByRole('button', { name: 'Retry' }),
				`the notice in place of an answer offers no Retry: ${credit}`
			).toBeVisible();
		expect(
			credit,
			`the first answer credits a model other than the picked ${other.name}: ${credit}`
		).toContain(family);
	}
);

// Step 3's third failure is a figure that looks openable and opens on nothing. The first test reads
// the unit off the page; this one opens the figure before anything is sent and checks the breakdown
// names both figures and says why it is shown. The meter and the method appear only once a reply has
// been counted (`hasActivity` in sessionFootprint.svelte.ts), which is after this step.
test(
	'opening the session footprint shows the breakdown behind the figure',
	{ tag: '@F3' },
	async ({ page }) => {
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		await journeyStep(page, 'F3', 3, async () => {
			await page
				.getByRole('button', { name: /^This session:.*Open the breakdown/ })
				.first()
				.click({ timeout: 30_000 });
			const sheet = page.locator('[data-footprint-sheet]').first();
			await expect(
				sheet,
				'the footprint figure opened on nothing, so the headline is the whole disclosure'
			).toBeVisible({ timeout: 15_000 });
			await expect(sheet.getByText('Energy', { exact: true })).toBeVisible();
			await expect(sheet.getByText('Time online', { exact: true })).toBeVisible();
			await expect(
				sheet.getByText(/We show you this on purpose/),
				'the breakdown no longer says why the figure is shown'
			).toBeVisible();
		});
	}
);

// Step 5's failure is an example that is decorative. Clicking one must send it: the conversation
// opens and the visitor's own message is the example's text. Canned replies, so no model is called.
test(
	'picking an example prompt sends it as the first message',
	{ tag: '@F3' },
	async ({ page }) => {
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		await journeyStep(page, 'F3', 5, async () => {
			const example = page.getByText('Prompt examples:').locator('..').getByRole('button').first();
			await expect(example).toBeEnabled({ timeout: 30_000 });
			const text = (await example.innerText()).trim();
			expect(text.length, 'the example prompt has no text').toBeGreaterThan(0);
			await example.click();

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(
				page.getByText(text, { exact: true }).first(),
				'clicking the example did not send it, so the visitor is back where they started'
			).toBeVisible({ timeout: 15_000 });
		});
	}
);
