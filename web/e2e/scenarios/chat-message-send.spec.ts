// e2e-product: @chat
// e2e-area: @composer @history @turn
import { test, expect, type BrowserContext, type Locator, type Page } from './helpers/test';
import { chatEntry, answerShapeEntry, CONVERSATION_URL, LARGE4_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import {
	installFaultInjectionHeader,
	type FaultInjectionName,
	installCannedReplies
} from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { skipVercelToolbar } from './helpers/vercelToolbar';
import { pinnedChatEntry } from './helpers/servedModel';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// Sending a message from the site's chat entry point creates a real conversation
// server-side, then the client-side goto() into /chat/conversation/[id] crosses from the Payload
// [...slug] route tree into the dedicated /chat/* tree. Nothing in test:client (Vitest browser
// mode, component-level only, no real SvelteKit router) is positioned to catch a route-tree-
// crossing crash like this — this scenario is.
//
// The entry is /chat on every target now (helpers/chatEntry.ts, CUR-2195); /alpha/chat 308s there.
// The name still says /alpha/chat, the path this spec opened when it was written. That is
// deliberate: `e2e-scope-classify.mjs` compares test() names as strings, so a rename is
// indistinguishable from a deletion to it and fails the isolation check. The gate is right to be
// strict about removed coverage and is not worth loosening for a cosmetic rename, so the name stays
// verbatim. Rename it in a commit that touches nothing else, if it ever seems worth the round trip.
test(
	'sending a message from /alpha/chat renders the conversation with no console exceptions',
	{ tag: '@F2' },
	async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(msg.text());
		});

		// A fresh visitor SOMETIMES lands behind the "Welcome to Alpha" onboarding dialog.
		// `showWelcome` is `$derived(!$settings.welcomeModalSeen && ...)` in ChatWindow.svelte, so the
		// dialog's appearance is gated on an ASYNC settings load — it can mount at ANY point after first
		// paint, including after the composer is already visible and after an action has begun. A bounded
		// wait for it is a bet on that round-trip's latency, and preview
		// runs ~2.5x slower than prod. Losing the bet is not benign: a modal dialog makes the rest of the
		// page inert, so `getByLabel('Message AI Potluck')` finds NOTHING and the click burns the whole
		// test timeout. That was the top failure of this suite in CI.
		//
		// addLocatorHandler is Playwright's own answer to an overlay that can interrupt at any moment:
		// before every actionability check it looks for this locator, and when it is visible it runs the
		// handler, waits for the overlay to go away, then proceeds with the original action. There is no
		// race left to lose and no poll interval to tune. Two earlier attempts here are why it is worth
		// spelling that out — a bounded `waitFor` lost the race outright, and a hand-rolled `toPass` poll
		// traded the race for a retry budget that then had to be tuned against a coverage gate rather than
		// against the thing it was measuring.
		//
		// Registered BEFORE the navigation, since the dialog can appear on first paint.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await installCannedReplies(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is 2+2?');
		await composer.press('Enter');

		// The goto() lands on /chat/conversation/[id] once the server-side conversation exists —
		// the crash this ticket names happens crossing INTO that route, so waiting on the URL alone
		// (not content) is deliberate: a crashed render can still update the URL via history state.
		// 30s, not 15s: the conversation URL can take longer than 15s to appear, and preview is
		// measurably ~2.5x slower than prod. This wait is not the assertion under
		// test — the claims are "the conversation renders" and "no console errors" below — so a generous
		// budget here buys determinism without weakening anything. If it ever needs raising AGAIN, that
		// is a latency finding worth chasing rather than another number to bump.
		await journeyStep(page, 'F2', 2, async () => {
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			// The dialog handler is new machinery, so assert it actually did its job rather than inferring that
			// from the click having worked. This also restores the file's timeout-bearing assertion count:
			// e2e-scope-classify.mjs counts those, addLocatorHandler legitimately removed two, and the honest
			// answer to a coverage gate is to widen rather than to argue with it. A stronger widening exists and
			// is worth its own change — asserting the assistant's REPLY arrives, not only the user's own bubble
			// — but this suite has no selector for an assistant message yet.
			await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

			// Prove the page actually rendered post-navigation, not just that the URL changed under a
			// blank/crashed tree — the user's own message bubble is the first thing that should exist.
			await expect(
				page.locator('[data-message-type="user"]').filter({ hasText: 'What is 2+2?' })
			).toBeVisible({
				timeout: 10_000
			});
		});

		expect(
			errors,
			`console errors after sending from ${chatEntry()}: ${errors.join('\n')}`
		).toEqual([]);
	}
);

// On a new chat's first turn the header read "Conversation" while the rail already named
// the same chat "New Chat", then switched to "New Chat", then to the real title (F1). Record every
// value the header takes from the first send until the turn ends.
test(
	'a new chat header never reads "Conversation" while the rail calls it "New Chat"',
	{ tag: '@F2' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.addInitScript(() => {
			const seen: string[] = [];
			(window as unknown as { __threadTitles: string[] }).__threadTitles = seen;
			const record = () => {
				const text = document.querySelector('[data-testid="thread-title"]')?.textContent?.trim();
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			};
			new MutationObserver(record).observe(document, {
				childList: true,
				subtree: true,
				characterData: true
			});
		});
		await installCannedReplies(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is 2+2?');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply)).toBeVisible({ timeout: 45_000 });

		const titles = await page.evaluate(
			() => (window as unknown as { __threadTitles: string[] }).__threadTitles
		);
		expect(titles.length, 'the header title was never seen during the first turn').toBeGreaterThan(
			0
		);
		expect(
			titles,
			`the header read the placeholder "Conversation" during a new chat's first turn: ${titles.join(' → ')}`
		).not.toContain('Conversation');
	}
);

// F2's second half (CUR-1616). The card a non-engineer reads on the journey
// gallery is headed "Alpha answers reliably, and users can always see which model answered", and
// until this test existed the suite under it asserted neither: the welcome dialog is hidden, the
// console is clean, and the page contains the sentence the test itself typed into the composer and
// the client echoed back optimistically. All three hold while every request 500s, because the user's
// own bubble renders locally either way — and all three held through a stall where six of twenty
// turns never answered at all (CUR-1600).
//
// Kept as its own test rather than folded into the one above, deliberately. A client-router crash
// crossing into /chat/conversation/[id] and a serving lane that accepts a turn and produces nothing
// are different failures with different owners; folded together, neither reports on a day the other
// is broken. Same reasoning as the status-page split in where-alpha-runs.spec.ts.
//
// The attribution half of the card title is NOT asserted here. F6 walks it against this same surface
// (where-alpha-runs.spec.ts), and a second assertion of one control would let a single change fix or
// break two journeys at once. docs/journeys/f2-send-a-message.md says so in Known gaps, so a reader
// of the card knows where that claim is actually tested.
test(
	'Alpha answers: a reply arrives with words in it, not an empty turn that ended quietly',
	{ tag: ['@F2', '@live'] },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await recordLiveModelLabels(page);

		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of France in one short sentence.');
		await composer.press('Enter');

		await page.waitForURL(CONVERSATION_URL, { timeout: 30_000 });

		const assistantMessage = await journeyStep(page, 'F2', 3, async () => {
			const assistantMessage = await expectAnAnswerWithWords(page);
			await expectTheAnswerNamesItsModel(assistantMessage);
			return assistantMessage;
		});

		// While the turn ran, the live line named a model; once it finished, the badge named one. Both
		// read resolveModelIdentity(...).short, so they can only disagree if one of them stops reading
		// it — and a "7B" or "700B" read off a recording was that suspicion, never a measurement
		// (CUR-1826, CUR-1956). This rides the same turn, so it costs no model call. What the badge
		// says is correct is F6's claim (where-alpha-runs.spec.ts); this only says the two agree.
		const badgeTitle = await assistantMessage
			.locator('[data-provenance="line"]')
			.first()
			.getAttribute('title', { timeout: 5_000 })
			.catch(() => null);
		const liveLabels = await page.evaluate(
			() => (window as unknown as LiveLabelWindow).__liveModelLabels ?? []
		);
		expect(badgeTitle, 'the model line carries no provenance title').toBeTruthy();
		const badgeModel = (badgeTitle ?? '').split(' · ')[0].replace(/ \(backup\b.*$/, '');
		const named = liveLabels.filter((label) => label !== 'The model');
		if (named.length === 0) {
			test.info().annotations.push({
				type: 'live-line-drift',
				description: `the live line never named a model this turn (saw: ${JSON.stringify(liveLabels)}), so the badge's "${badgeModel}" had nothing to agree with`
			});
			return;
		}
		expect(
			named.at(-1),
			`the live line called the model "${named.at(-1)}" while the turn ran, and the finished answer's badge says "${badgeModel}" — the two surfaces disagree about which model answered (every name the line showed: ${JSON.stringify(named)})`
		).toBe(badgeModel);
	}
);

// The reply test's own Done-when. The assertions above are what F2's card rests on, so they
// have to go red for the failure the card is named after: a turn the lane accepts and answers with
// nothing. `no_assistant_reply` makes the server yield no content after the turn starts. The turn
// used to stay open, so the assertion that fired was "the answer never finished within 45s", the
// CUR-1600 stall shape. Develop now ends that turn with
// "No output was generated." as an alert inside the bubble, so the notice check fires in seconds
// (CUR-2757). The error must come from one of the reply assertions, so a navigation or
// sign-in failure cannot pass for the proof.
// Preview-only: the fault switch is never armed on production.
test(
	'Alpha answers: the reply assertions go red when the lane accepts a turn and returns nothing',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'no_assistant_reply');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of France.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const verdict = await expectAnAnswerWithWords(page).then(
			async (message) => ({ passed: true as const, body: (await message.innerText()).trim() }),
			(err: Error) => ({ passed: false as const, error: err.message })
		);
		expect(
			verdict.passed,
			`F2's reply assertions passed on a turn forced to return nothing, so the card can go green while the lane answers no one. The body they accepted: ${JSON.stringify(verdict.passed ? verdict.body : '')}`
		).toBe(false);
		expect(
			verdict.passed ? '' : verdict.error,
			'the reply assertions failed, but not on the answer: something before it broke, so this run proves nothing about F2'
		).toMatch(REPLY_FAILURE);
		test.info().annotations.push({
			type: 'injury-proof',
			description: verdict.passed ? '' : verdict.error.split('\n')[0]
		});
	}
);

// The same proof for the other faults F2's reply rests on. A send that fails outright
// (`chat_500`) and a lane that drops mid-answer (`stream_truncates_midway`) must each fail the reply
// assertions; a lane that reports no provenance (`provenance_header_stripped`) must fail the
// model-naming ones. Preview-only: the fault switch is never armed on production.
const REPLY_FAILURE =
	/no assistant message ever rendered|the answer never finished|rendered nothing|ended on a notice/;

test(
	'Alpha answers: the reply assertions go red when the send itself answers 500',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const verdict = await underInjury(page, 'chat_500', expectAnAnswerWithWords);
		expect(verdict.passed, "F2's reply assertions passed on a send that answered 500").toBe(false);
		expect(verdict.error, 'the reply assertions failed on something other than the answer').toMatch(
			REPLY_FAILURE
		);
	}
);

test(
	'Alpha answers: the reply assertions go red when the answer is cut off partway',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const verdict = await underInjury(page, 'stream_truncates_midway', expectAnAnswerWithWords);
		expect(
			verdict.passed,
			"F2's reply assertions passed on an answer whose lane closed after twelve tokens"
		).toBe(false);
		expect(verdict.error, 'the reply assertions failed on something other than the answer').toMatch(
			REPLY_FAILURE
		);
	}
);

test(
	'Alpha answers: the model-naming assertions go red when nothing reports which model served',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const verdict = await underInjury(page, 'provenance_header_stripped', async (p) =>
			expectTheAnswerNamesItsModel(await expectAnAnswerWithWords(p))
		);
		expect(
			verdict.passed,
			"F2's model-naming assertions passed on an answer nothing reported a model for"
		).toBe(false);
		expect(
			verdict.error,
			'the assertions failed before the model line, so this run proves nothing about naming'
		).toMatch(/names no model under it|nothing reported which model served it/);
	}
);

// Waits for the last assistant message to finish and asserts it has words in it; returns it so the
// caller can read its badge. Shared by the F2 reply test and its injury proof, so the proof always
// exercises exactly the assertions the card rests on.
async function expectAnAnswerWithWords(page: Page) {
	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	await expect(
		assistantMessage,
		'no assistant message ever rendered — the turn was accepted and the answer never appeared, which is the failure this journey is named after'
	).toBeVisible({ timeout: 30_000 });

	// CopyToClipBoardBtn is the app's own "this answer is finished" signal — ChatMessage.svelte
	// gates it on `!isLast || !loading`, so waiting here waits on the app's own completion state
	// rather than on a proxy for it. 45s matches the A2 and F6 journeys; CUR-1600's stall fires its
	// hard unwind at ~63s, so a turn caught by that lands red here rather than timing out the suite.
	// A turn that ends on a notice and no copy button would otherwise sit out the full 45s
	// before the notice check below reads it, so stop at whichever shows first.
	const finished = assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true });
	const notice = assistantMessage.getByRole('alert');
	await expect(
		finished.or(notice).first(),
		'the answer never finished within 45s, so it is still streaming or the lane hung — CUR-1600 is this shape: a lane that accepts a turn and produces nothing never throws, so the ladder above it waits forever' +
			warmupContext()
	).toBeVisible({ timeout: 45_000 });
	if (!(await finished.isVisible())) {
		await expect(
			notice,
			'the answer ended on a notice saying it was interrupted or failed, so the visitor got part of an answer or none'
		).toHaveCount(0);
	}
	await expect(
		finished,
		'the answer never finished within 45s, so it is still streaming or the lane hung — CUR-1600 is this shape: a lane that accepts a turn and produces nothing never throws, so the ladder above it waits forever' +
			warmupContext()
	).toBeVisible({ timeout: 45_000 });

	// The copy control's accessible name is what a screen reader announces. Its "Copied" tooltip
	// stays in the DOM while faded out, and used to become the name before anything was copied.
	await expect(
		assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true }),
		'the answer\'s copy button does not announce as "Copy to clipboard" before it has been used'
	).toBeVisible();
	await expect(assistantMessage.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(
		0
	);

	// The assertion the card's own title rests on. A finished turn whose body is empty is the exact
	// state CUR-1600 produced and the one the three assertions above this test could not see: the
	// page is healthy, the console is clean, the conversation exists, and there is nothing in it.
	const reply = (await assistantMessage.innerText()).trim();
	expect(
		reply.length,
		`the answer completed and rendered nothing — an empty assistant turn, which reads to a user as a product that ignored them: "${reply}"`
	).toBeGreaterThan(0);

	// A turn cut off partway still finishes with words in it, so the two checks above pass
	// it. What marks it is the notice the bubble ends on (interrupted, empty or errored), and every
	// one of those is a role="alert" inside the message.
	await expect(
		assistantMessage.getByRole('alert'),
		'the answer ended on a notice saying it was interrupted or failed, so the visitor got part of an answer or none'
	).toHaveCount(0);
	return assistantMessage;
}

// An errored turn drops the model line for a Status page link (the timed-out test below
// asserts that half). An answered turn has to keep naming the model under it. Shared with the
// provenance injury proof, so the proof exercises exactly these two assertions.
async function expectTheAnswerNamesItsModel(assistantMessage: Locator) {
	await expect(
		assistantMessage.locator('[data-how-made]'),
		'a successful answer names no model under it, so the visitor cannot see which model answered'
	).toBeVisible({ timeout: 5_000 });
	await expect(
		assistantMessage.locator('[data-provenance="unavailable"]'),
		'the answer says nothing reported which model served it'
	).toHaveCount(0);
}

// Sends one turn under `fault` and returns how F2's own assertions fared on it. A pass is a
// failed proof; the caller checks the failure came from the assertion the fault is named after.
async function underInjury(
	page: Page,
	fault: FaultInjectionName,
	assertions: (page: Page) => Promise<unknown>
) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await installFaultInjectionHeader(page, fault);
	await page.goto(chatEntry(), { waitUntil: 'commit' });

	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill('In three sentences, why is the sky blue?');
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

	const verdict = await assertions(page).then(
		() => ({ passed: true as const, error: '' }),
		(err: Error) => ({ passed: false as const, error: err.message })
	);
	test.info().annotations.push({
		type: 'injury-proof',
		description: `${fault}: ${verdict.error.split('\n')[0]}`
	});
	return verdict;
}

type LiveLabelWindow = { __liveModelLabels?: string[] };

// Records every model name the live request log shows, in order, without duplicates in a row. The line
// unmounts when the turn finishes, so it has to be caught while it is on screen; an init script keeps
// the observer across the entry page's navigation into /chat/conversation/<id>.
async function recordLiveModelLabels(page: import('@playwright/test').Page) {
	await page.addInitScript(() => {
		const w = window as unknown as LiveLabelWindow;
		w.__liveModelLabels = [];
		const pattern = /^(.+?) is (?:generating|computing|working)…$/;
		const scan = () => {
			for (const span of document.querySelectorAll(
				'[aria-live="polite"] > div > span:last-child'
			)) {
				const match = pattern.exec(span.textContent?.trim() ?? '');
				if (match && w.__liveModelLabels!.at(-1) !== match[1]) w.__liveModelLabels!.push(match[1]);
			}
		};
		// Init scripts run once the document exists and before its own scripts, so the root is there.
		new MutationObserver(scan).observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true
		});
	});
}

// Step 4 (CUR-1686). Preview-only claim: conversation-titles is at 100% on env=preview and has NO
// production group. So on a preview the only passing source is `model`, and
// `titling-disabled` passes (annotated) only against production.
//
// Run again pinned to Large 4, whose native turn used to title a conversation with its first
// words and never made the title call.
type Fixtures = { page: Page; context: BrowserContext; baseURL: string | undefined };

async function sideRailNamesConversation(
	{ page, baseURL }: Fixtures,
	native: boolean
): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	const againstProduction = /^(www\.)?aipotluck\.org$/.test(new URL(baseURL!).hostname);

	await page.goto(native ? pinnedChatEntry(LARGE4_MODEL) : chatEntry(), {
		waitUntil: 'commit'
	});

	const sentText = 'What is the capital of Japan?';
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	// Hold the post-turn conversation-list refresh until the title check below has run.
	// The rail used to show a title only once that refresh replaced the whole list, seconds after
	// the header already had it, so with the refresh held the rail has to follow the Title update
	// itself or this step fails.
	let releaseListRefresh = () => {};
	const listRefreshHeld = new Promise<void>((resolve) => (releaseListRefresh = resolve));
	await page.route(/\/api\/v2\/conversations\?p=0/, async (route) => {
		await listRefreshHeld;
		await route.continue();
	});

	// With the rail open from the start, as in the gallery recording that caught CUR-2379. A collapsed
	// rail never runs its infinite scroll, and that is the path that left the rail on a stale copy.
	const openSidebarFirst = page.getByRole('button', { name: 'Open sidebar' });
	if (await openSidebarFirst.isVisible()) await openSidebarFirst.click();

	await composer.fill(sentText);
	await composer.press('Enter');

	await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	await expect(
		assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true }),
		'the answer never finished, so a title generated off the completed turn was never reachable' +
			warmupContext()
	).toBeVisible({ timeout: 45_000 });

	// Title generation is a second, server-side model call that runs ALONGSIDE the answer
	// (`textGeneration/index.ts` merges the two streams), so it usually lands before the answer
	// finishes, and can lag it by a few seconds when it doesn't.
	//
	// WAIT ON THE SOURCE, NOT ON THE TEXT (CUR-1819).
	//
	// `generateTitle` returns the first five words down FOUR paths — the `conversation-titles` flag off, a
	// reply `looksLikeTitle` rejected (CUR-593), a thrown call, and a call still in flight — so asserting
	// `not.toHaveText(firstFiveWords)` cannot tell them apart, and two of the four are correct product
	// behaviour. A longer wait cannot fix a question that was never about waiting.
	//
	// `data-title-source` carries which path ran. It is set from the Title message update while this
	// page watches the turn, so it is present here and absent on a fresh load — the server persists
	// the text and not the provenance. The post-turn sidebar refresh must not erase it, or this step
	// stays red while the rail shows a real model title (CUR-1971).
	const railLink = page.locator(`a[href$="/conversation/${conversationId}"]`).first();
	const fallbackFirstFiveWords = sentText.split(/\s+/).slice(0, 5).join(' ');

	const { source, title } = await journeyStep(page, 'F2', 4, async () => {
		await expect(
			railLink,
			'the side rail never recorded which path produced this conversation title within 30s, so the ' +
				'title-generation call had not reported back at all, or the rail only updates on the list ' +
				'refresh this step holds (CUR-2379)' +
				warmupContext()
		).toHaveAttribute('data-title-source', /.+/, { timeout: 30_000 });

		const source = await railLink.getAttribute('data-title-source');
		const title = (await railLink.innerText()).trim();

		// The title was read from the DOM while the rail sat collapsed to icons, so no frame of
		// this recording ever showed it and the step graded as claimed but not seen. Open the rail the
		// way a person glancing at it would, and require the title to be visible there.
		const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
		if (await openSidebar.isVisible()) await openSidebar.click();
		await expect(
			railLink,
			'the conversation title is in the page but not on screen, so nobody glancing at the rail sees it'
		).toBeVisible({ timeout: 10_000 });
		await expect(railLink).toHaveText(title);
		// The header and the rail name the conversation the same way, with the list refresh
		// still held, so neither is waiting on the other to catch up.
		await expect(
			page.locator('header').getByRole('button', { name: title, exact: true }),
			'the chat header and the side rail name this conversation differently'
		).toBeVisible();
		releaseListRefresh();
		return { source, title };
	});

	// The three fallback sources are NOT equivalent, and collapsing them is the defect this rewrite
	// exists to undo. Each gets the treatment it earns:
	//
	//   generation-failed       the call threw. A real fault, and the one this step is named after.
	//   titling-disabled        the flag is off for this deployment, which is correct on production
	//                           (the flag is scoped to env=preview). The disabled path has its own
	//                           contract: the rail shows exactly the prompt's first five words.
	//                           Assert that on production, and annotate it. On a preview the flag
	//                           is at 100%, so this source fails the step there. No skip: a skipped
	//                           test still counts its expect()s, and this suite excludes by tag at
	//                           the runner instead.
	//   reply-not-title-shaped  the model answered the question instead of naming it and the product
	//                           deliberately showed the prompt instead (CUR-593). Correct behaviour,
	//                           so this passes on production — annotated, because a deployment where
	//                           it happens every run is a model-obedience problem worth seeing on the
	//                           board. On a preview it fails: the prompt is fixed and titling runs at
	//                           temperature 0, so it would be a titling regression there.
	expect(
		source,
		'the title-generation call threw, so this conversation has no title for a reason that is a ' +
			'real fault rather than a configuration'
	).not.toBe('generation-failed');

	if (source === 'titling-disabled' && !againstProduction) {
		throw new Error(
			'the conversation-titles flag resolved off on a preview, where it is at 100% — no model was ' +
				'asked to name this conversation, so the claim this step is named after was not exercised'
		);
	}
	if (source === 'titling-disabled') {
		test.info().annotations.push({
			type: 'titling-disabled',
			description:
				'the conversation-titles flag is off for this deployment, so no model was asked to name ' +
				'this conversation. Expected on production; on a preview it means the flag did not resolve.'
		});
		expect(
			title,
			'titling is off, so the rail should show exactly the first five words of the prompt'
		).toBe(fallbackFirstFiveWords);
		return;
	}

	// On a preview the step only passes on a model-generated title. The prompt is fixed and titling
	// runs at temperature 0, so a reply that is not title-shaped here is a regression in the titling
	// prompt or the model, not the everyday CUR-593 fallback.
	expect(
		againstProduction || source === 'model',
		`the rail's title came from "${source}", not from the model, on a preview where titling is on`
	).toBe(true);

	if (source === 'reply-not-title-shaped') {
		test.info().annotations.push({
			type: 'fallback',
			description:
				'the model answered the question instead of naming it, so the rail shows the first five ' +
				'words by design (CUR-593). The rail is correct; the model was not obedient.'
		});
		return;
	}

	expect(
		title,
		'the rail reported a model-generated title and then rendered an empty entry'
	).not.toBe('');
	expect(
		title,
		`the rail reported source "model" but rendered the first-five-words fallback ` +
			`("${fallbackFirstFiveWords}"), so the two disagree about what happened`
	).not.toBe(fallbackFirstFiveWords);
}
test(
	'after one answer, the side rail names the conversation for what it was about',
	{ tag: '@F2' },
	async ({ page, context, baseURL }) => sideRailNamesConversation({ page, context, baseURL }, false)
);
test(
	'a native turn on Large 4 also gets its conversation named in the side rail after one answer',
	{ tag: ['@F2', '@preview-only', '@CUR-2734'] },
	async ({ page, context, baseURL }) => sideRailNamesConversation({ page, context, baseURL }, true)
);

// Step 5 (CUR-1686). Single-turn, deliberately: this is the claim reaching the board, not a re-run of
// the grader. web/scripts/arithmetic-turn-probe.mjs already does the hard multi-turn cross-anchoring
// work for CUR-853/958 with independently-derived expected values — this step reuses its turn-1
// prompt verbatim rather than deriving a new one, since turn 1 is also the only turn that probe's own
// gate scores (later turns inherit an anchor and can fail for reasons unrelated to this diff).
// arithmetic-guard is at 100% on both env=preview and env=production.
test(
	'a multi-step calculation in a message gets a final number that is actually right',
	{ tag: '@F2' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		await journeyStep(page, 'F2', 5, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(
				'My team has 12 people and 3 of them work part time at 50 percent. How many full time equivalents is that?'
			);
			await composer.press('Enter');
			await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const assistantMessage = page.locator('[data-message-role="assistant"]').last();
			// Retry, not the copy button: a calc block's own copy button shows before the turn ends (CUR-2133).
			await expect(
				turnDone(assistantMessage),
				'the answer never finished within 45s, so the number below was never checkable' +
					warmupContext()
			).toBeVisible({ timeout: 45_000 });

			const reply = await assistantMessage.innerText();
			// The confident-wrong shape first (CUR-2134): a bold "Total:" line, the shape the code-rendered
			// ledger takes, that is not the right one. `/10\.5/` below passes it whenever the prose also
			// says 10.5, and the total line is the number a reader trusts.
			// A worked line ("Total: 9 + 1.5 = 10.5 FTEs") states its result last, so read the line's final
			// number; its first is an addend (CUR-3345).
			const totals = [...reply.matchAll(/^Total:[^\n]*/gm)]
				.map((m) => m[0].match(/-?\d+(?:[.,]\d+)*/g)?.at(-1))
				.filter((v): v is string => v !== undefined);
			expect(
				totals.filter((v) => v !== '10.5'),
				`a "Total:" line is not 10.5: ${JSON.stringify(totals)}`
			).toEqual([]);
			expect(
				reply,
				`expected the worked total 10.5 (9 full-time + 3 part-time at 50% = 9 + 1.5) somewhere in the answer, got: "${reply.slice(0, 300)}"`
			).toMatch(/10\.5/);
		});
	}
);

// While a new turn is still in its pre-stream phase (safety check, sources, before the first token)
// the composer used to offer Send instead of Stop: the landing page cleared the shared `$loading`
// after navigating, over the conversation page's own claim to it. A follow-up typed then was lost.
// The snapshot below is taken in the same frame the pre-stream label is on screen, so a Stop that
// only appears once tokens flow cannot pass it.
test(
	'during the pre-stream phase of a turn, Stop shows and a second message cannot be sent or lost',
	{ tag: '@F2' },
	async ({ page }) => {
		// Sends a real turn and waits up to 90s for it, after up to 60s of setup (CUR-1633's budget check).
		test.setTimeout(180_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Give me two bullet points on a staff remote-work policy.');
		await composer.press('Enter');

		const snapshot = await page
			.waitForFunction(
				() => {
					if (!/\/chat\/conversation\/[a-f0-9]+/.test(location.pathname)) return false;
					const assistants = document.querySelectorAll('[data-message-role="assistant"]');
					const label =
						(assistants[assistants.length - 1] as HTMLElement | undefined)?.innerText ?? '';
					if (
						!/(Working on it|is working|Checking safety|our documents|the web|Checking for calculations|is computing)…/.test(
							label
						)
					)
						return false;
					const input = document.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="Message AI Potluck"]'
					);
					return {
						label: label.slice(0, 60),
						stop: !!document.querySelector('button[aria-label="Stop generating"]'),
						composerDisabled: input?.disabled ?? null
					};
				},
				undefined,
				{ timeout: 30_000, polling: 'raf' }
			)
			.then((h) => h.jsonValue());

		// A user acting in that same moment: type a follow-up and press Enter if the composer lets them.
		let secondAccepted = false;
		if (snapshot && !snapshot.composerDisabled) {
			await composer.fill('Now make it one sentence.');
			await composer.press('Enter');
			secondAccepted = (await composer.inputValue()) === '';
		}

		// Soft, so the reload check below still reports whether a follow-up was actually lost.
		expect
			.soft(
				snapshot,
				`while "${snapshot && snapshot.label}" was on screen the composer offered Send, not Stop`
			)
			.toMatchObject({ stop: true, composerDisabled: true });

		await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
			timeout: 90_000
		});
		// On a full page load the header read its title from the rail's list, which streams in
		// after first paint, so it said "Conversation" for a second or more. Record every value the header
		// title takes from the first parsed byte of the reload, not only the settled one.
		await page.addInitScript(() => {
			const seen: string[] = [];
			(window as unknown as { __threadTitles: string[] }).__threadTitles = seen;
			const record = () => {
				const text = document.querySelector('[data-testid="thread-title"]')?.textContent?.trim();
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			};
			new MutationObserver(record).observe(document, {
				childList: true,
				subtree: true,
				characterData: true
			});
		});
		await page.reload({ waitUntil: 'load' });
		// Every message the composer accepted must still be there. The second one only counts if the
		// composer took it (Enter cleared the box); a blocked send is not a lost one.
		await expect(
			page.getByText('Give me two bullet points on a staff remote-work policy.', { exact: true })
		).toBeVisible({ timeout: 30_000 });
		if (secondAccepted) {
			await expect(
				page.getByText('Now make it one sentence.', { exact: true }),
				'the follow-up sent during the pre-stream phase was accepted, then lost'
			).toBeVisible({ timeout: 30_000 });
		}
		// The first painted value is what this guards, and the transcript being visible above means it
		// was painted and recorded long ago.
		await expect(page.getByTestId('thread-title')).not.toHaveText('', { timeout: 30_000 });
		const titles = await page.evaluate(
			() => (window as unknown as { __threadTitles: string[] }).__threadTitles
		);
		expect(titles.length, 'the header title was never seen during the reload').toBeGreaterThan(0);
		expect(
			titles,
			'after a reload the header showed the placeholder "Conversation" before the chat\'s own title'
		).not.toContain('Conversation');
	}
);

// Edit and Copy under the person's own message were display:none until mouse hover, so on a phone
// (no hover) and by keyboard they could not be reached at all. Playwright counts opacity 0 as
// visible, so the opacity is asserted as well as visibility.
test.describe('own-message actions on a touch phone', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	// Vercel injects its feedback toolbar into previews, and at phone width it sits over the send button
	// and intercepts the tap (production never shows it). Same opt-out as e2e/visual (CUR-2132).
	test.beforeEach(async ({ page, baseURL }) => {
		await skipVercelToolbar(page, baseURL!);
	});
	test(
		'on a touch phone, Edit and Copy under your own message are showing, sit clear of the bubble, and Edit opens a labelled box @CUR-4264',
		{ tag: '@F2' },
		async ({ page }) => {
			// Sends a real turn and waits up to 90s for it, after up to 60s of setup (CUR-1633's budget check).
			test.setTimeout(180_000);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});

			await installCannedReplies(page);
			await page.goto(chatEntry(), { waitUntil: 'commit' });
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name the capital of France in one short sentence.');
			// On a touch device Enter inserts a newline, as it does for a real phone user.
			await page.getByRole('button', { name: 'Send message' }).tap();
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			// The actions render only once the turn has finished.
			await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
				timeout: 90_000
			});

			const edit = page.getByRole('button', { name: 'Edit', exact: true }).last();
			const copy = edit.locator('xpath=following-sibling::button[1]');
			for (const [name, control] of [
				['Edit', edit],
				['Copy', copy]
			] as const) {
				await expect(control, `${name} is not rendered under the message`).toBeVisible();
				await expect(control, `${name} is there but transparent on a touch screen`).toHaveCSS(
					'opacity',
					'1'
				);
			}

			// They were pinned 8px up into the bubble, so on a phone (where they always show)
			// they were drawn over the bottom edge of every sent message.
			const bubble = page
				.locator('[data-message-type="user"]')
				.last()
				.getByText('Name the capital of France in one short sentence.');
			const bubbleBox = (await bubble.boundingBox())!;
			for (const [name, control] of [
				['Edit', edit],
				['Copy', copy]
			] as const) {
				const box = (await control.boundingBox())!;
				const overlaps =
					box.x < bubbleBox.x + bubbleBox.width &&
					bubbleBox.x < box.x + box.width &&
					box.y < bubbleBox.y + bubbleBox.height &&
					bubbleBox.y < box.y + box.height;
				expect(
					overlaps,
					`${name} is drawn over the message bubble (button top ${box.y}, bubble bottom ${bubbleBox.y + bubbleBox.height})`
				).toBe(false);
			}

			await edit.tap();
			const editBox = page.getByRole('textbox', { name: 'Edit your message' });
			await expect(editBox).toBeVisible();

			// The session footprint used to bloom as a fixed card over the thread for 3s after the
			// first reply, and this tap lands inside that window. Whatever is topmost at the edit box's
			// corners and centre must be the box itself, so no overlay can sit on it.
			const covering = await editBox.evaluate((box) => {
				const r = box.getBoundingClientRect();
				const points = [
					[r.left + 8, r.top + 8],
					[r.right - 8, r.top + 8],
					[r.left + r.width / 2, r.top + r.height / 2]
				];
				return points
					.map(([x, y]) => document.elementFromPoint(x, y))
					.filter((el) => !el || !box.contains(el))
					.map((el) => el?.outerHTML.slice(0, 120) ?? 'nothing');
			});
			expect(covering, 'something covers the edit box right after Edit is tapped').toEqual([]);

			// Cancel rendered as bare grey text beside a filled Send, so on a phone it did not
			// read as something to tap. A button's rest state carries a visible edge.
			const cancel = page
				.locator('form[data-editing-bubble]')
				.getByRole('button', { name: 'Cancel' });
			// Every button carries a 1px border, transparent on a ghost one, so this reads the colours'
			// alpha (painted onto a canvas, which resolves oklch and color-mix) rather than the width.
			const restState = await cancel.evaluate((el) => {
				const s = getComputedStyle(el);
				const ctx = document.createElement('canvas').getContext('2d')!;
				const alpha = (color: string) => {
					ctx.clearRect(0, 0, 1, 1);
					ctx.fillStyle = color;
					ctx.fillRect(0, 0, 1, 1);
					return ctx.getImageData(0, 0, 1, 1).data[3];
				};
				const border =
					s.borderTopStyle === 'none' || s.borderTopWidth === '0px' ? 0 : alpha(s.borderTopColor);
				return { border, fill: alpha(s.backgroundColor) };
			});
			expect(
				restState.border + restState.fill,
				'Cancel in the edit box has no visible border or fill, so it reads as text'
			).toBeGreaterThan(0);
		}
	);
});

// A long Large 3 answer on develop stopped mid-sentence at 45s because the total cap cut a
// turn that was still streaming. The `answer_streams_past_cap` fault shortens that cap to 4s and
// streams a fixed answer for about 10s, a token every half second, so the turn is mid-stream when the
// cap arrives. The fix lets it finish; without it this ends on "took too long" after part 8.
// Preview-only: the fault switch is never armed on production.
test(
	'an answer still streaming when the total cap arrives finishes instead of being cut off',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'answer_streams_past_cap');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Explain photosynthesis in detail.');
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText('Part 1 of a long answer.'),
			'the fault never streamed — the header did not reach the server'
		).toBeVisible({ timeout: 30_000 });
		await expect(
			reply.getByText('The long answer reached its last sentence.'),
			'the answer was cut before its last token: the total cap ended a turn that was still streaming'
		).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/took too long to respond/i)).toHaveCount(0);
		// A finished answer keeps the footer's Retry; a cut one adds a notice (role alert) with its own.
		await expect(
			reply.getByRole('alert'),
			'the turn ended on a timeout or interrupted notice'
		).toHaveCount(0);
	}
);

// A timed-out turn said so three times. The failed bubble's own notice ("The request took
// too long…" with a Retry, CUR-1748), a toast repeating it, and a compose-area Retry above a disabled
// composer reading "Sorry, something went wrong" — two messages and two Retries for one failure.
// The `generation_timeout` fault holds the turn open until the route's real watchdog fires, so this
// is the production timeout path rather than a mocked stream. Preview-only: the fault switch is
// never armed on production (faultInjection.ts). The fault shortens the watchdog from 45s to 15s
// (CUR-2757); the abort path is the same at either length.
test(
	'a timed-out turn shows one error, in the turn itself, with one Retry',
	{ tag: ['@F2', '@C3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'generation_timeout');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		const reply = await journeyStep(page, 'C3', 3, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name one fruit.');
			await composer.press('Enter');
			await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			// The notice names the model that ran out of time, so match the sentence after it.
			const timedOut = /took too long to respond\. Please try again\./;
			const reply = page.locator('[data-message-role="assistant"]').last();

			// The wait before the watchdog fires is exactly the wait that read as a frozen screen, so
			// the live line has to count it.
			await expectTheWaitIsCounted(reply);

			await expect(
				reply.getByText(timedOut),
				'the forced timeout never surfaced in the turn — the watchdog did not fire, or the fault header did not reach the server'
			).toBeVisible({ timeout: 90_000 });

			// One place says it: the failed turn. Not a toast, not the composer.
			await expect(
				page.getByText(timedOut),
				'the timeout message is shown more than once'
			).toHaveCount(1);
			await expect(page.getByTestId('chat-error-toast')).toHaveCount(0);
			await expect(page.getByText('Sorry, something went wrong')).toHaveCount(0);
			await expect(composer).not.toHaveValue(/something went wrong/i);

			// One Retry on the page, and it belongs to the failed turn.
			const retries = page.getByRole('button', { name: 'Retry' });
			await expect(retries, 'more than one Retry is offered for one failed turn').toHaveCount(1);
			await expect(reply.getByRole('button', { name: 'Retry' })).toBeVisible();
			return reply;
		});

		// Beside Retry, a way to check whether Alpha is down. And no "No provenance" line:
		// no model served this turn, and the notice above already says what happened.
		const statusLink = reply.getByRole('link', { name: 'Status page' });
		await expect(statusLink, 'the failed turn offers no status page link').toBeVisible();
		await expect(statusLink).toHaveAttribute('href', 'https://status.aipotluck.org');
		await expect(
			reply.locator('[data-provenance="unavailable"]'),
			'the failed turn says nothing reported which model served it'
		).toHaveCount(0);

		// The composer stays open beside the one Retry, and does not repeat the error.
		await expect(composer).toBeEnabled();
		await expect(composer).toHaveValue('');
	}
);

// After a failed turn the composer used to lock until Retry, so someone whose question
// could not be answered could only send the same question again. Two failures differ in what the
// server kept. `no_assistant_reply` saves the question and then answers nothing, as www did for the
// capped benefit sum (CUR-4490): the failed turn stays, with its one Retry (CUR-1921). `chat_500`
// fails before the question is saved, so the page's copy is the only one: the new question goes in
// its place. Questions carry `data-message-type="user"`; only answers carry `data-message-role`.
for (const { fault: faultName, kept } of [
	{ fault: 'no_assistant_reply', kept: true },
	{ fault: 'chat_500', kept: false }
] as const) {
	test(
		`CUR-4494: after a ${faultName} failure the composer takes a reworded question and it is answered in its own turn`,
		{ tag: ['@A5', '@C3', '@preview-only', '@CUR-4494'] },
		async ({ page }) => {
			test.setTimeout(180_000);
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			const fault = await installFaultInjectionHeader(page, faultName);
			await page.goto(chatEntry(), { waitUntil: 'commit' });

			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name one lake in Switzerland.');
			await composer.press('Enter');
			const failed = page.locator('[data-message-role="assistant"]').last();
			await expect(
				failed.getByRole('alert'),
				'the failed send shows no notice; if it answered, the fault never reached the server'
			).toBeVisible({ timeout: 90_000 });

			await expect(composer, 'the composer is locked after a failed turn').toBeEnabled();
			await expect(composer).toHaveValue('');
			await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();

			// The next question goes through without the fault and is answered in its own turn.
			fault.disarm();
			await composer.fill('Name one river in Switzerland.');
			await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
			await composer.press('Enter');
			await expect(composer, 'the reworded question never left the composer').toHaveValue('', {
				timeout: 10_000
			});
			const questions = page.locator('[data-message-type="user"]');
			await expect(questions.last(), 'the reworded question is not on the page').toContainText(
				'Name one river in Switzerland.',
				{ timeout: 30_000 }
			);
			const answer = page.locator('[data-message-role="assistant"]').last();
			await expect(turnDone(answer), 'the new question never finished').toBeVisible({
				timeout: 90_000
			});
			await expect(answer.getByRole('alert'), 'the new question failed too').toHaveCount(0);
			await expect(answer, 'the new question got no answer').toContainText(/\p{L}{3,}/u);

			if (kept) {
				// The saved failed turn stays above the new one, still offering its Retry.
				await expect(questions).toHaveCount(2);
				await expect(questions.first()).toContainText('Name one lake in Switzerland.');
				const first = page.locator('[data-message-role="assistant"]').first();
				await expect(first.getByRole('button', { name: 'Retry' })).toBeVisible();
			} else {
				await expect(questions, 'the never-saved turn is still on the page').toHaveCount(1);
			}
			// The answer is still there once the page settles on the server's copy.
			await page.reload();
			await expect(page.locator('[data-message-type="user"]').last()).toContainText(
				'Name one river in Switzerland.',
				{ timeout: 30_000 }
			);
		}
	);
}

// With output screening on, a short answer's tail used to wait for the conversation title,
// because the screen held the tail until the whole merged stream ended and the title is part of that
// stream. The fault starts the title call 10s after the answer is final. A fixed server shows the
// whole answer, then the title about 10s later. A regressed one holds the answer back and releases it
// together with the title, so both land in the same moment.
//
// That is why this measures the gap rather than the order: under the regression the answer is
// complete by the time the title renders too, just 10s late, so an ordering check passes either way
// (it did). The page is sampled every frame for when the answer's text last
// changed and when the rail first records a title source. Copy and Stop can't be the signal: both
// follow `loading`, which clears at the answer's FinalAnswer, and under the regression that FinalAnswer
// is itself held back until the title (the next test pins `loading` to FinalAnswer, CUR-2089).
test(
	'a new conversation shows its whole answer before its title arrives',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'title_latency_10s');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name one fruit, in one word.');
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const seen = await page
			.waitForFunction(
				(id) => {
					const w = window as unknown as {
						__cur1907?: { text: string; changedAt: number };
					};
					const replies = document.querySelectorAll('[data-message-role="assistant"]');
					const last = replies[replies.length - 1];
					const text = [...(last?.querySelectorAll('.prose') ?? [])]
						.map((p) => (p as HTMLElement).innerText)
						.join('\n')
						.trim();
					const now = performance.now();
					if (!w.__cur1907 || w.__cur1907.text !== text) w.__cur1907 = { text, changedAt: now };
					const rail = document.querySelector(`a[href$="/conversation/${id}"]`);
					if (!rail?.getAttribute('data-title-source')) return false;
					return { text, gapMs: Math.round(now - w.__cur1907.changedAt) };
				},
				conversationId,
				{ timeout: 90_000, polling: 'raf' }
			)
			.then((h) => h.jsonValue() as Promise<{ text: string; gapMs: number }>);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply)).toBeVisible({ timeout: 45_000 });
		const finalAnswer = (await reply.locator('.prose').allInnerTexts()).join('\n').trim();

		expect(
			finalAnswer,
			'the turn ended with no answer text, so there was nothing to time'
		).not.toBe('');
		expect(
			seen.text,
			'the title arrived before the answer finished rendering, so the answer waited on its title'
		).toBe(finalAnswer);
		// The fault holds the title 10s past the model finishing, but output screening runs after that and
		// before the visitor sees the answer; a saturated guard (CUR-3749) spent 6s of the 10 there. 2s still
		// keeps a same-moment release (gap near 0) out.
		expect(
			seen.gapMs,
			`the answer settled only ${seen.gapMs}ms before the title appeared, so it was held back and released with the title`
		).toBeGreaterThanOrEqual(2_000);
	}
);

// The answer is whole on screen, but its turn stays "running" until the stream closes, and
// the title call is part of that stream. So Stop stays up and Copy stays hidden for as long as the
// title takes, which on develop has run to the 45s watchdog. The fault starts the title call 10s after
// the answer is final: a fixed page offers Copy and drops Stop as soon as the answer settles, and the
// title still reaches the rail about 10s later.
test(
	'a new conversation offers Copy on its answer before its title arrives, and still gets the title',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'title_latency_10s');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name one vegetable.');
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		// Sampled every frame until the rail records a title: when the answer's text last changed, and
		// when Copy first showed on it with Stop gone.
		const seen = await page
			.waitForFunction(
				(id) => {
					const w = window as unknown as {
						__cur2089?: { text: string; changedAt: number; settledAt?: number };
					};
					const replies = document.querySelectorAll('[data-message-role="assistant"]');
					const last = replies[replies.length - 1];
					const text = [...(last?.querySelectorAll('.prose') ?? [])]
						.map((p) => (p as HTMLElement).innerText)
						.join('\n')
						.trim();
					const now = performance.now();
					if (!w.__cur2089 || w.__cur2089.text !== text) {
						w.__cur2089 = { text, changedAt: now };
					}
					const copy = last?.querySelector(
						'[aria-label="Copy to clipboard"], [title="Copy to clipboard"]'
					);
					const stop = document.querySelector('button[aria-label="Stop generating"]');
					if (text && copy && !stop && w.__cur2089.settledAt === undefined) {
						w.__cur2089.settledAt = now;
					}
					const rail = document.querySelector(`a[href$="/conversation/${id}"]`);
					if (!rail?.getAttribute('data-title-source')) return false;
					const s = w.__cur2089;
					return {
						text: s.text,
						settledAfterTextMs:
							s.settledAt === undefined ? null : Math.round(s.settledAt - s.changedAt),
						titleAfterSettledMs: s.settledAt === undefined ? null : Math.round(now - s.settledAt)
					};
				},
				conversationId,
				{ timeout: 90_000, polling: 'raf' }
			)
			.then(
				(h) =>
					h.jsonValue() as Promise<{
						text: string;
						settledAfterTextMs: number | null;
						titleAfterSettledMs: number | null;
					}>
			);

		expect(seen.text, 'the turn ended with no answer text, so there was nothing to time').not.toBe(
			''
		);
		expect(
			seen.settledAfterTextMs,
			'Copy never showed (or Stop never left) before the title arrived, so the turn stayed running until the title'
		).not.toBeNull();
		expect(
			seen.settledAfterTextMs!,
			`Copy showed only ${seen.settledAfterTextMs}ms after the answer settled`
		).toBeLessThanOrEqual(3_000);
		// The title still lands in the rail, from the same stream, after the turn has ended for the visitor.
		// 2s, not the fault's 10: output screening spends part of the 10 before Copy can show (see above).
		expect(
			seen.titleAfterSettledMs!,
			`the title arrived ${seen.titleAfterSettledMs}ms after Copy, so the fault did not hold it back and this measured nothing`
		).toBeGreaterThanOrEqual(2_000);
	}
);

// A send the server refuses before streaming used to erase what the person typed. The
// optimistic bubble was rolled back on resync because the server never saved it, the composer stayed
// empty, and the reason flashed for five seconds. Preview caps a message at 12,000 characters
// (USAGE_LIMITS.messageLength), so one over that draws a real 400 "Message too long: …" from
// parseRequest, with no fault injection in the path. Tagged @preview-only because the cap is
// per-environment config, and prod's could differ.
test(
	'a send refused before streaming keeps the typed text in the composer and its reason on screen',
	{ tag: ['@F2', '@C3', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const typed =
			`CUR-1896 check, deliberately over the length cap: ${'lorem ipsum '.repeat(1_050)}`.trim();
		expect(typed.length).toBeGreaterThan(12_000);
		const composer = page.getByLabel('Message AI Potluck');
		await journeyStep(page, 'C3', 1, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill(typed);
			await composer.press('Enter');

			const reason = page.getByText(/^Message too long:/);
			await expect(reason).toBeVisible({ timeout: 30_000 });

			// Watch the reason in-page for 10.5s rather than sleeping and looking once: a toast that left and
			// came back would pass a single look, and this records the moment it left if it did.
			const watch = await page
				.waitForFunction(
					() => {
						const w = window as unknown as { __cur1896?: { since: number; goneAt?: number } };
						const now = performance.now();
						w.__cur1896 ??= { since: now };
						// The reason shows in the design system's toast (3195a5f365), which has no h2.
						const shown = !!document
							.querySelector('[data-testid="chat-error-toast"]')
							?.textContent?.trim()
							.startsWith('Message too long:');
						if (!shown && w.__cur1896.goneAt === undefined) w.__cur1896.goneAt = now;
						if (w.__cur1896.goneAt !== undefined) {
							return { heldMs: Math.round(w.__cur1896.goneAt - w.__cur1896.since) };
						}
						return now - w.__cur1896.since >= 10_500 ? { heldMs: null } : false;
					},
					undefined,
					{ polling: 250, timeout: 20_000 }
				)
				.then((h) => h.jsonValue() as Promise<{ heldMs: number | null }>);

			// Read once the watch above has run its 10.5s, long after the restore would have landed. Compared
			// as a verdict string so a failure reports what the composer held, not 12k characters of expected
			// text, and soft so a run that loses the text still reports how long the reason stayed.
			const value = await composer.inputValue();
			expect
				.soft(
					value === typed ? 'restored' : `holds ${value.length} of ${typed.length} chars`,
					'the refused message should be back in the composer, not erased'
				)
				.toBe('restored');
			expect(
				watch.heldMs,
				`the reason left the screen ${watch.heldMs}ms after it appeared; it should stay past 10s`
			).toBeNull();
		});
	}
);

// The test above proves the refused text comes back. This one proves it never left. Before
// the fix the over-long message rendered as a sent bubble under "The model is working…" for about a
// second, until the server's 400 rolled it back into the composer — a refusal that looked like an
// acceptance first. A watcher in the page records any frame where either shows, from before Enter until
// the reason is on screen, so a flash between two Playwright polls still counts.
test(
	'an over-long message is refused in the composer and never shows as sent',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const marker = 'CUR-1921 check, over the length cap';
		const typed = `${marker}: ${'lorem ipsum '.repeat(1_050)}`.trim();
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(typed);

		// A textarea's value is not in innerText, so the marker only shows up there if it rendered as a
		// message somewhere on the page.
		await page.evaluate((m) => {
			const w = window as unknown as { __cur1921: string[] };
			w.__cur1921 = [];
			const look = () => {
				const text = document.body.innerText;
				if (text.includes(m) && !w.__cur1921.includes('sent')) w.__cur1921.push('sent');
				if (text.includes('is working…') && !w.__cur1921.includes('working'))
					w.__cur1921.push('working');
			};
			new MutationObserver(look).observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true
			});
		}, marker);
		await composer.press('Enter');

		await expect(page.getByText(/^Message too long:/)).toBeVisible({ timeout: 30_000 });
		// Give a late render its chance: before the fix the bubble appeared first and the reason came after.
		await expect(composer).toHaveValue(typed);
		const seen = await page.evaluate(
			() => (window as unknown as { __cur1921: string[] }).__cur1921
		);
		expect(
			seen,
			'the refused message showed as sent, or a pending "working…" line appeared'
		).toEqual([]);
	}
);

// The refusal used to read only "Message too long.", so a person could see they were refused
// but not how much to cut. It now names the message's length, the limit and the difference, and says
// the text was kept. Preview's cap is 12,000 characters (see the CUR-1896 test above), so the expected
// numbers come from the typed text's own length, not from anything the page reports.
test(
	'CUR-3695: an over-long message is refused with its length, the limit and how much to cut',
	{ tag: ['@F2', '@C3', '@preview-only', '@CUR-3695'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const limit = 12_000;
		const typed = `CUR-3695 check, over the length cap: ${'lorem ipsum '.repeat(1_050)}`.trim();
		const n = new Intl.NumberFormat('en');
		const expected = `Message too long: ${n.format(typed.length)} characters, the limit is ${n.format(limit)}. Cut ${n.format(typed.length - limit)} to send it; your text is still here.`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(typed);
		await composer.press('Enter');

		const toast = page.getByTestId('chat-error-toast');
		await expect(
			toast,
			'the refusal does not name the length, the limit and how much to cut'
		).toHaveText(expected, { timeout: 30_000 });
		// A reason cut off mid-sentence would still match toHaveText, so the title must not be clipped.
		const clipped = await toast
			.locator('[data-toast-title]')
			.evaluate((h) => h.scrollHeight > h.clientHeight + 1);
		expect(clipped, 'the refusal is clipped by the toast').toBe(false);
		await expect(composer, 'the refused text left the composer').toHaveValue(typed);
	}
);

// Send kept its ready look while the draft was over the cap, so nothing said a press would
// only be refused. Over the cap it is aria-disabled and dimmed, and a click on it still brings up the
// refusal; under the cap again it is ready. Opacity is read from the page, since a dimmed control that
// still looks the same in a recording is the defect.
test(
	'CUR-2703: Send looks blocked while the message is over the length limit, and a click still says why',
	{ tag: ['@F2', '@C3', '@preview-only', '@CUR-2703'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		const send = page.getByRole('button', { name: 'Send message' });
		const opacity = () => send.evaluate((b) => Number(getComputedStyle(b).opacity));
		await composer.click({ timeout: 30_000 });
		await composer.fill('How long can a message be?');
		await expect(send).toBeEnabled();
		// Polled: the button eases its opacity, so one read just after the state flips can land mid-fade.
		await expect
			.poll(opacity, { message: 'Send should look ready under the cap' })
			.toBeGreaterThan(0.9);

		const typed = `How long can a message be? ${'lorem ipsum '.repeat(1_050)}`.trim();
		await composer.fill(typed);
		await expect(send, 'Send should say it is blocked over the cap').toHaveAttribute(
			'aria-disabled',
			'true'
		);
		await expect
			.poll(opacity, { message: 'Send should look dimmed over the cap' })
			.toBeLessThan(0.6);

		// force: Playwright treats aria-disabled as not actionable, and a person's click is what this checks.
		await send.click({ force: true });
		await expect(page.getByText(/^Message too long:/)).toBeVisible({ timeout: 30_000 });
		await expect(composer).toHaveValue(typed);

		await composer.fill('How long can a message be, roughly?');
		await expect(send).not.toHaveAttribute('aria-disabled', 'true');
		await expect(send).toBeEnabled();
	}
);

// An error toast must never cover the chat header or the session footprint at its right
// edge, where "Forget everything" lives. Toasts sit in the bottom-right corner on desktop, above the
// composer so they never cover Send either, and along the top on phones, below the header. Same refused
// send as above for a real toast with no fault injection, so also @preview-only. 1024 is the narrowest
// desktop width, where the toast and the composer sit closest.
async function expectToastPlacement(page: Page, width: number, height: number, phone: boolean) {
	test.setTimeout(90_000);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(chatEntry(), { waitUntil: 'commit' });

	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(`Can you summarise this? ${'lorem ipsum '.repeat(1_050)}`);
	// A phone's Enter adds a line rather than sending (isVirtualKeyboard), so a phone taps Send, which
	// stays clickable over the cap so the tap lands on the refusal (CUR-2703). force: Playwright treats its
	// aria-disabled as not actionable, and a person's tap is what this checks.
	if (phone) await page.getByRole('button', { name: 'Send message' }).click({ force: true });
	else await composer.press('Enter');
	const toast = page.getByTestId('chat-error-toast');
	// The DS toast pads its text with whitespace, so the reason is matched after it.
	await expect(toast).toContainText(/^\s*Message too long:/, { timeout: 30_000 });
	// The send can leave the document scrolled, which moves the titlebar and the session bar out from
	// under a toast that is position: fixed, and the check would pass on geometry the visitor never
	// sees. Measure at the top, where the page first opens.
	await page.evaluate(() => window.scrollTo(0, 0));
	// Let the stack's entrance finish before measuring it.
	await expect(async () => {
		const a = await toast.boundingBox();
		await page.waitForTimeout(100);
		const b = await toast.boundingBox();
		expect(a && b && a.y === b.y && a.height === b.height).toBe(true);
	}).toPass({ timeout: 5_000 });

	const box = (await toast.boundingBox())!;
	expect(box, 'the toast should be on screen').not.toBeNull();
	if (phone) {
		expect(
			box.y + box.height / 2,
			`the toast ${JSON.stringify(box)} is not in the top half on a phone`
		).toBeLessThan(height / 2);
	} else {
		expect(
			box.x + box.width / 2,
			`the toast ${JSON.stringify(box)} is not on the right on desktop`
		).toBeGreaterThan(width / 2);
		expect(
			box.y + box.height / 2,
			`the toast ${JSON.stringify(box)} is not in the bottom half on desktop`
		).toBeGreaterThan(height / 2);
	}
	// The chat header, the session footprint at its right edge, and Send are what the toast must clear.
	const targets: Record<
		string,
		Promise<{ x: number; y: number; width: number; height: number } | null>
	> = {
		'chat header': page.locator('header:visible').first().boundingBox(),
		'session footprint': page.locator('[data-footprint-trigger]:visible').first().boundingBox(),
		'send button': page
			.getByRole('button', { name: 'Send message', exact: true })
			.first()
			.boundingBox()
	};
	for (const [name, pending] of Object.entries(targets)) {
		const target = await pending;
		expect(target, `the ${name} should be on screen at ${width}×${height}`).not.toBeNull();
		const overlapX =
			Math.min(box.x + box.width, target!.x + target!.width) - Math.max(box.x, target!.x);
		const overlapY =
			Math.min(box.y + box.height, target!.y + target!.height) - Math.max(box.y, target!.y);
		expect(
			overlapX > 0 && overlapY > 0 ? Math.round(overlapX * overlapY) : 0,
			`toast ${JSON.stringify(box)} vs ${name} ${JSON.stringify(target)}, overlapping area in px²`
		).toBe(0);
	}
}

test.describe('at 1280×720', () => {
	test.use({ viewport: { width: 1280, height: 720 } });
	test(
		'the error toast sits bottom right, clear of the chat header, the session footprint and Send, at 1280×720',
		{ tag: ['@F2', '@preview-only'] },
		async ({ page }) => expectToastPlacement(page, 1280, 720, false)
	);
});

test.describe('at 1024×768', () => {
	test.use({ viewport: { width: 1024, height: 768 } });
	test(
		'the error toast sits bottom right, clear of the chat header, the session footprint and Send, at 1024×768',
		{ tag: ['@F2', '@preview-only'] },
		async ({ page }) => expectToastPlacement(page, 1024, 768, false)
	);
});

test.describe('at 390×844', () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	test(
		'the error toast sits at the top on a phone, clear of the chat header, the session footprint and Send',
		{ tag: ['@F2', '@preview-only'] },
		async ({ page }) => expectToastPlacement(page, 390, 844, true)
	);
});

// A wait the live line does not count reads as a frozen screen. Two readings a few seconds
// apart must differ. Shared by the timeout test above and the slow-answer test below.
async function expectTheWaitIsCounted(reply: Locator) {
	const elapsed = reply.getByTestId('live-elapsed');
	const uncounted =
		'the live line held past five seconds without counting how long it had been running';
	// Visible first: toHaveText reads the text whether or not the visitor can see it.
	await expect(elapsed, uncounted).toBeVisible({ timeout: 20_000 });
	await expect(elapsed, uncounted).toHaveText(/^· \d+s$/, { timeout: 20_000 });
	const firstCount = Number((await elapsed.innerText()).match(/\d+/)?.[0]);
	await expect
		.poll(async () => Number((await elapsed.innerText()).match(/\d+/)?.[0]), {
			message: 'the elapsed count on the live line stopped advancing',
			timeout: 10_000
		})
		.toBeGreaterThanOrEqual(firstCount + 2);
}

// CUR-1614 `latency_30s`: an answer that is slow but alive. The turn waits 30s with keepalives flowing,
// then streams a fixed reply (LATENCY_FAULT_REPLY in textGeneration/index.ts), so the wait is the only
// variable. The visitor must see the wait counted, then the reply, as an ordinary finished answer with
// no error. Preview-only: the fault switch is never armed on production.
test(
	'a slow answer is counted while it waits, then arrives as an ordinary reply',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'latency_30s');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name one river.');
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expectTheWaitIsCounted(reply);

		await expect(
			reply.getByText('it is the latency fault'),
			'the slow reply never arrived: the client gave up on a live turn, or the fault never reached the server'
		).toBeVisible({ timeout: 60_000 });
		await expect(
			reply.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'the slow reply arrived but the turn never finished'
		).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('chat-error-toast')).toHaveCount(0);
		await expect(reply.getByText(/took too long|something went wrong/i)).toHaveCount(0);
	}
);

// The slow-answer test above must go red for the failure it guards, a 30s wait the visitor
// can't see being counted. Under the same fault, a stylesheet hides the elapsed counter, and the
// counted-wait check has to fail with its own message. CSS rather than removing the node: Svelte
// re-renders a removed node inside the assertion's retry window. Preview-only, like the fault.
test(
	'a slow answer: the counted-wait check goes red when the elapsed counter is hidden',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		// An init script, so the stylesheet is in place on every document the turn passes through.
		await page.addInitScript(() => {
			// eslint-disable-next-line svelte/no-add-event-listener -- runs in the browser before Svelte loads
			document.addEventListener('DOMContentLoaded', () => {
				const style = document.createElement('style');
				style.textContent = '[data-testid="live-elapsed"] { display: none !important; }';
				document.head.append(style);
			});
		});
		const verdict = await underInjury(page, 'latency_30s', (p) =>
			expectTheWaitIsCounted(p.locator('[data-message-role="assistant"]').last())
		);
		expect(
			verdict.passed,
			'the counted-wait check passed with no elapsed counter on screen, so a frozen-looking wait would read green'
		).toBe(false);
		expect(verdict.error, 'the check failed on something other than the counter').toMatch(
			/without counting how long it had been running/
		);
	}
);

// Every failed-send spec stops at "Retry is visible". This one presses it. The send fails
// once (`chat_500` on the first POST only), and Retry has to bring one fresh answer in place of the
// notice, with the question asked once and answered once.
const SEND_FAILED = /The connection dropped before a reply arrived/;
const START_CHATTING = /start chatting/i;

test(
	'pressing Retry after a failed send brings one fresh answer, with no duplicate question or answer',
	{ tag: ['@F2', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.getByRole('button', { name: START_CHATTING }).click();
		});
		const fault = await installFaultInjectionHeader(page, 'chat_500');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const question = 'What is the tallest mountain in Wales?';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const notice = page.locator('[data-message-role="assistant"]').last().getByRole('alert');
		await expect(
			notice,
			'the first send did not fail: the fault header did not reach the server'
		).toContainText(SEND_FAILED, { timeout: 90_000 });
		fault.disarm();

		await journeyStep(page, 'F2', 7, async () => {
			await notice.getByRole('button', { name: 'Retry' }).click();
			await expectAnAnswerWithWords(page);
			await expect(
				page.getByText(SEND_FAILED),
				'the failure notice is still on the page after Retry brought an answer'
			).toHaveCount(0);
			await expect(
				page.locator('[data-message-type="user"]').filter({ hasText: question }),
				'Retry left the question on the page twice'
			).toHaveCount(1);
			await expect(
				page.locator('[data-message-role="assistant"]'),
				'Retry left a second answer bubble beside the first'
			).toHaveCount(1);
		});
	}
);

// The other way a turn fails. Here the server saved the question, then its watchdog ended
// the turn (`generation_timeout`), so Retry regenerates a stored answer rather than resending a
// question the server never kept.
// The notice names the model that ran out of time, so match the sentence after it.
const TIMED_OUT = /took too long to respond\. Please try again\./;

test(
	'pressing Retry after a timed-out turn brings one fresh answer, with no duplicate question or answer',
	{ tag: ['@F2', '@C3', '@CUR-2803', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.getByRole('button', { name: START_CHATTING }).click();
		});
		const fault = await installFaultInjectionHeader(page, 'generation_timeout');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const question = 'Name one river in Wales.';
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText(TIMED_OUT),
			'the turn never timed out: the watchdog did not fire, or the fault header did not reach the server'
		).toBeVisible({ timeout: 90_000 });
		fault.disarm();

		// The same press is C3's step 10 (trying again from the notice) and F2's step 9 (no duplicates).
		await journeyStep(page, 'C3', 10, () =>
			journeyStep(page, 'F2', 9, async () => {
				await reply.getByRole('button', { name: 'Retry' }).click();
				await expectAnAnswerWithWords(page);
				await expect(
					page.getByText(TIMED_OUT),
					'the timeout notice is still on the page after Retry brought an answer'
				).toHaveCount(0);
				await expect(
					page.locator('[data-message-type="user"]').filter({ hasText: question }),
					'Retry left the question on the page twice'
				).toHaveCount(1);
				await expect(
					page.locator('[data-message-role="assistant"]'),
					'Retry left a second answer bubble beside the first'
				).toHaveCount(1);
			})
		);
	}
);
