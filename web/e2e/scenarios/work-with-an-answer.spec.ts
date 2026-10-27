// e2e-product: @chat
// e2e-area: @turn
// CUR-2625 — journey C2 (docs/journeys/c2-work-with-an-answer.md): Stop, Retry, Copy and Edit, the
// answer controls a visitor brings from Claude or ChatGPT. Each is driven and its effect read back:
// the stopped text stays, Retry leaves a 2 / 2 counter, the clipboard holds the answer, and an edited
// question keeps its first version one click away. Runs as a visitor, since Edit only asks for
// sign-in when AUTOMATIC_LOGIN is on, and it is off on preview and production.
import { randomBytes } from 'node:crypto';
import { test, expect, type Page } from './helpers/test';
import { chatEntry, answerShapeEntry } from './helpers/chatEntry';
import { holdForRecording } from './helpers/recording';
import { journeyStep } from './helpers/journeyStep';
import { holdAnswerForStop, installFaultInjectionHeader } from './helpers/faultInjection';

const FIRST_QUESTION =
	'C2 journey: write a detailed 400-word essay on the history of river trade in medieval Europe.';
const EDITED_QUESTION = 'C2 journey: in one sentence, what was river trade in medieval Europe?';

async function answerText(page: Page): Promise<string> {
	const answer = page.locator('[data-message-role="assistant"]').last();
	return (await answer.locator('.prose').allInnerTexts()).join('\n').trim();
}

/** A reply's first 60 characters, whitespace folded: enough to tell two versions apart. */
const lead = (t: string) => t.replace(/\s+/g, ' ').slice(0, 60);

test(
	'a visitor stops a reply, retries it, copies it, and edits their question with a way back',
	{ tag: ['@C2', '@CUR-2625', '@CUR-3329'] },
	async ({ page, context }) => {
		test.setTimeout(240_000);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		// A PR run's replayed reply arrives whole at once, so Stop was gone before the click (CUR-4027);
		// the first reply is held after one sentence there, and Retry's reply is a fresh one.
		const held = await holdAnswerForStop(page);
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const { answer, retry, afterStop } = await journeyStep(page, 'C2', 1, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(FIRST_QUESTION);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			// Step 1: Stop mid-reply; the text shown stays and doesn't grow.
			const stop = page.getByRole('button', { name: 'Stop generating' });
			await expect(stop, 'the reply never started streaming').toBeVisible({ timeout: 30_000 });
			// With output screening on, text arrives a sentence chunk at a time or all at the end,
			// so wait for any text and stop at once (CUR-2749). Waiting for a length either stalled short of it or let
			// the reply finish before the click.
			await expect
				.poll(() => answerText(page).then((t) => t.length), {
					message: 'no reply text reached the screen',
					timeout: 60_000
				})
				.toBeGreaterThan(0);
			await expect(stop, 'the reply finished before any of it could be stopped').toBeVisible({
				timeout: 1_000
			});
			await stop.click({ timeout: 5_000 });
			held?.disarm();
			const atStop = await answerText(page);
			const answer = page.locator('[data-message-role="assistant"]').last();
			// A stopped reply carries the interrupted notice, and the notice's Retry is the
			// turn's only one (CUR-2864); the toolbar drops its copy while a notice shows.
			const retry = answer.getByRole('alert').getByRole('button', { name: 'Retry', exact: true });
			await expect(retry, 'a stopped reply offers no Retry').toBeVisible({ timeout: 30_000 });
			await expect(
				answer.getByRole('button', { name: 'Retry', exact: true }),
				'a stopped reply offers Retry twice, in its notice and its toolbar'
			).toHaveCount(1);
			const afterStop = await answerText(page);
			expect(afterStop.length, 'the reply grew after Stop').toBeLessThanOrEqual(atStop.length);
			expect(afterStop.length, 'the partial reply vanished after Stop').toBeGreaterThan(0);
			await holdForRecording(page);
			return { answer, retry, afterStop };
		});

		// Step 2: Retry streams a fresh reply and keeps the stopped one behind a 2 / 2 counter.
		const { copy, retried, counter } = await journeyStep(page, 'C2', 2, async () => {
			await retry.click();
			const copy = page
				.locator('[data-message-role="assistant"]')
				.last()
				.getByRole('button', { name: 'Copy to clipboard', exact: true });
			await expect(copy, 'the retried reply never finished').toBeVisible({ timeout: 120_000 });
			const retried = await answerText(page);
			// The counter sits in the answer's footer, below the fold under a long reply, so bring it on
			// screen; CUR-2667's grader read a recording that never showed it as "no counter".
			const counter = answer.getByText(/^\s*\d+\s*\/\s*\d+\s*$/);
			await counter.scrollIntoViewIfNeeded();
			await expect(counter, 'Retry left no version counter').toHaveText(/2\s*\/\s*2/);
			await expect(counter).toBeInViewport();
			await holdForRecording(page);
			return { copy, retried, counter };
		});

		// The stopped reply is still there one step back, and the counter returns to the retry. A second
		// visit to row 2, since keeping the stopped reply is half of what the row promises.
		await journeyStep(page, 'C2', 2, async () => {
			await answer.getByRole('button', { name: 'Previous version' }).click();
			await expect(counter).toHaveText(/1\s*\/\s*2/);
			await expect
				.poll(() => answerText(page).then(lead), {
					message: 'Previous version did not bring back the stopped reply'
				})
				.toBe(lead(afterStop));
			await counter.scrollIntoViewIfNeeded();
			await holdForRecording(page);
			await answer.getByRole('button', { name: 'Next version' }).click();
			await expect(counter).toHaveText(/2\s*\/\s*2/);
			await expect.poll(() => answerText(page).then(lead)).toBe(lead(retried));
		});

		// Step 3: Copy puts the reply's text on the clipboard and says so.
		await journeyStep(page, 'C2', 3, async () => {
			const shown = await answerText(page);
			await copy.click();
			await expect(
				page
					.locator('[data-message-role="assistant"]')
					.last()
					.getByRole('button', { name: 'Copied' })
			).toBeVisible();
			const clipboard = await page.evaluate(() => navigator.clipboard.readText());
			// Copy hands over the reply's markdown and the page shows it rendered, so a bold heading is
			// "**Title**" on one side and "Title" on the other; compare with the markers folded out.
			const plain = (t: string) =>
				t
					.replace(/[*_#`]/g, '')
					.replace(/\s+/g, ' ')
					.trim();
			expect(plain(clipboard), 'the clipboard does not hold the reply').toContain(
				plain(shown).slice(0, 60)
			);
		});

		// Step 4: edit the question in its bubble; a new version and a new reply follow.
		const question = page.locator('[data-message-type="user"]').first();
		await journeyStep(page, 'C2', 4, async () => {
			await question.hover();
			await question.getByRole('button', { name: 'Edit', exact: true }).click();
			const editor = page.getByLabel('Edit your message');
			await editor.fill(EDITED_QUESTION);
			await holdForRecording(page);
			await page.locator('[data-editing-bubble]').getByRole('button', { name: 'Send' }).click();
			await expect(question).toContainText(EDITED_QUESTION, { timeout: 30_000 });
			await expect(
				page
					.locator('[data-message-role="assistant"]')
					.last()
					.getByRole('button', { name: 'Copy to clipboard', exact: true }),
				'the edited question never got its reply'
			).toBeVisible({ timeout: 120_000 });
			await expect(question).toContainText(/2\s*\/\s*2/);
			await holdForRecording(page);
		});

		// Step 5: the counter's previous arrow brings the first question back, with its own replies as
		// they were: the retried one it was left on at 2 / 2, and the stopped one a step behind it.
		// CUR-3329's grader expected the stopped reply up front; step 2 left the retry selected.
		await journeyStep(page, 'C2', 5, async () => {
			await question.hover();
			await question.getByRole('button', { name: 'Previous version' }).click();
			await expect(question).toContainText(FIRST_QUESTION);
			await expect(question).toContainText(/1\s*\/\s*2/);
			await expect
				.poll(() => answerText(page).then(lead), {
					message: 'the first question came back without the reply it was left on'
				})
				.toBe(lead(retried));
			await counter.scrollIntoViewIfNeeded();
			await expect(counter).toHaveText(/2\s*\/\s*2/);
			await holdForRecording(page);
			await answer.getByRole('button', { name: 'Previous version' }).click();
			await expect(counter).toHaveText(/1\s*\/\s*2/);
			await expect
				.poll(() => answerText(page).then(lead), {
					message: 'the first question lost its stopped reply'
				})
				.toBe(lead(afterStop));
			await holdForRecording(page);
		});
	}
);

// CUR-2824 — C2 row 6: Stop pressed before any of the reply arrived. `latency_30s` holds the turn 30s
// before its first token, so the press lands in the empty window every time instead of racing the
// stream. With nothing to keep, the bubble must say the reply was stopped and offer Retry, never the
// failure line "No answer was produced". Preview-only, like the fault.
test(
	'a reply stopped before any of the reply arrived says so and offers Retry',
	{ tag: ['@C2', '@preview-only', '@CUR-2824'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'latency_30s');
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		await journeyStep(page, 'C2', 6, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill('C2 journey: name one river.');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const stop = page.getByRole('button', { name: 'Stop generating' });
			await expect(stop, 'the turn never started').toBeVisible({ timeout: 30_000 });
			expect(await answerText(page), 'text arrived before Stop, so this is not row 6').toBe('');
			await stop.click({ timeout: 5_000 });

			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(
				reply.getByText('Stopped before any answer arrived.'),
				'a reply stopped before any text did not say it was stopped'
			).toBeVisible({ timeout: 15_000 });
			await expect(reply.getByText('No answer was produced for this message.')).toHaveCount(0);
			// The notice's own Retry: the answer toolbar may carry one too, so read it inside the notice.
			await expect(
				reply.getByRole('alert').getByRole('button', { name: 'Retry', exact: true })
			).toBeVisible();
			await holdForRecording(page);
		});
	}
);

// CUR-3018 — C2 row 6 on a cold instance: Stop pressed before the server has saved the question.
// `question_save_delayed` holds the question's first write for 8s, so the press lands before it every
// time. The pane used to go blank a moment after the stopped notice showed, because the post-stop
// refresh loaded a snapshot without the turn; and a reload showed no stopped notice, because nothing
// marked the turn interrupted once the server did save it. Preview-only, like the fault.
test(
	'a first question stopped before the server saved it stays on screen as stopped, and after a reload',
	{ tag: ['@C2', '@preview-only', '@CUR-3018'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'question_save_delayed');
		const nonce = randomBytes(5).toString('hex');
		const question = `CUR-3018 stop check ${nonce}: name one river.`;
		// The page's own reads of this conversation. Before Stop, remember the newest one that lacks
		// the question: the server's copy inside the gap. From Stop until the server has saved the turn,
		// answer the page's reads with that copy, so the post-stop refresh lands inside the gap every
		// run instead of only when the server is slow (about one attempt in three).
		let gapSnapshot: string | undefined;
		let holdGap = false;
		await page.route(/\/chat\/api\/v2\/conversations\/[a-f0-9]+(\?.*)?$/, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			if (holdGap && gapSnapshot) {
				return route.fulfill({ status: 200, contentType: 'application/json', body: gapSnapshot });
			}
			const res = await route.fetch();
			const body = await res.text();
			if (!body.includes(nonce)) gapSnapshot = body;
			return route.fulfill({ response: res, body });
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		await journeyStep(page, 'C2', 6, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
			if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

			const stop = page.getByRole('button', { name: 'Stop generating' });
			await expect(stop, 'the turn never started').toBeVisible({ timeout: 30_000 });
			await expect(page.getByText(question)).toBeVisible();
			expect(
				gapSnapshot,
				'the page never read its conversation before the question was saved'
			).toBeDefined();
			// The blank lasts only until some later refresh reconciles, so record whether the question
			// ever leaves the page from Stop onwards rather than checking once at the end.
			await page.evaluate((needle) => {
				const w = window as unknown as { __questionLeft?: boolean };
				w.__questionLeft = false;
				new MutationObserver(() => {
					if (!document.body.innerText.includes(needle)) w.__questionLeft = true;
				}).observe(document.body, { childList: true, subtree: true, characterData: true });
			}, nonce);
			holdGap = true;
			await stop.click({ timeout: 5_000 });

			const storedQuestion = async () => {
				const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
				const stored = (await res.json()) as {
					json?: { messages?: Array<{ content?: string; from?: string; interrupted?: boolean }> };
				};
				return stored.json?.messages ?? [];
			};
			expect(
				(await storedQuestion()).some((m) => m.content?.includes(nonce)),
				'the question was already saved when Stop landed, so this run never opened the gap'
			).toBe(false);

			// The server's half: the question is saved once the held write lands, with its answer marked
			// stopped. Waiting on it also outlasts the page's post-stop refresh, which is what blanked it.
			await expect
				.poll(
					async () => {
						const msgs = await storedQuestion();
						const asked = msgs.some((m) => m.from === 'user' && m.content?.includes(nonce));
						const stopped = msgs.at(-1)?.from === 'assistant' && msgs.at(-1)?.interrupted === true;
						return asked && stopped;
					},
					{
						message:
							'the server never saved the stopped question with its answer marked interrupted',
						timeout: 45_000
					}
				)
				.toBe(true);

			expect(
				await page.evaluate(
					() => (window as unknown as { __questionLeft?: boolean }).__questionLeft
				),
				'the question vanished from the page after Stop'
			).toBe(false);
			holdGap = false;
			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(page.getByText(question)).toBeVisible();
			await expect(
				reply.getByText('Stopped before any answer arrived.'),
				'the stopped notice vanished from the page after Stop'
			).toBeVisible();

			await page.reload({ waitUntil: 'commit' });
			await expect(
				page.getByText(question),
				'the stopped question was gone after a reload'
			).toBeVisible({ timeout: 30_000 });
			await expect(
				page
					.locator('[data-message-role="assistant"]')
					.last()
					.getByText('Stopped before any answer arrived.'),
				'after a reload the stopped question no longer said it was stopped'
			).toBeVisible({ timeout: 15_000 });
			await holdForRecording(page);
		});
	}
);

// CUR-2971 — C2 row 6, pressed on /chat itself: Stop in the moment between Enter and the new
// conversation's page taking over. That press used to reach no handler, so the full answer arrived
// anyway. The conversation create is held until Stop has been pressed, so the press always lands on
// the landing page, and `latency_30s` keeps any answer from arriving inside the assertion window.
// Preview-only, like the fault.
test(
	'Stop pressed on /chat before the conversation opens stops the reply and keeps the question',
	{ tag: ['@C2', '@preview-only', '@CUR-2971'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'latency_30s');
		let releaseCreate: () => void = () => {};
		const stopPressed = new Promise<void>((resolve) => (releaseCreate = resolve));
		await page.route(/\/chat\/conversation$/, async (route) => {
			if (route.request().method() === 'POST') await stopPressed;
			await route.continue();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		await journeyStep(page, 'C2', 6, async () => {
			const question = 'C2 journey: name one mountain.';
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');

			const stop = page.getByRole('button', { name: 'Stop generating' });
			await expect(stop, 'the send never showed Stop on the landing page').toBeVisible({
				timeout: 10_000
			});
			expect(
				page.url(),
				'the conversation page opened before Stop, so this is not the case'
			).not.toMatch(/\/conversation\//);
			await stop.click({ timeout: 5_000 });
			releaseCreate();

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(
				reply.getByText('Stopped before any answer arrived.'),
				'Stop pressed on /chat was ignored: the reply was not stopped'
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(question), 'the stopped question was not kept').toBeVisible();
			await expect(
				reply.getByRole('alert').getByRole('button', { name: 'Retry', exact: true })
			).toBeVisible();
			await holdForRecording(page);
		});
	}
);

// CUR-2823 — C2 row 3, refused: a browser or embed that blocks the clipboard. Both the Clipboard API and
// the old execCommand path refuse here, so the only honest outcome is the control saying it couldn't
// copy. The footer used to swallow the rejection and leave the Copy button as it was.
test(
	'a Copy the browser refuses says it could not copy, instead of doing nothing',
	{ tag: ['@C2', '@CUR-2823'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) }
			});
			document.execCommand = () => false;
		});
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('C2 journey: name one river in one word.');
		await composer.press('Enter');
		const reply = page.locator('[data-message-role="assistant"]').last();
		const copy = reply.getByRole('button', { name: 'Copy to clipboard', exact: true });
		await expect(copy, 'the answer never finished, so there was nothing to copy').toBeVisible({
			timeout: 90_000
		});

		await journeyStep(page, 'C2', 3, async () => {
			await copy.click();
			await expect(
				reply.getByRole('button', { name: "Couldn't copy" }),
				'a refused copy left the control as it was, saying nothing'
			).toBeVisible({ timeout: 5_000 });
			await expect(reply.getByRole('button', { name: 'Copied' })).toHaveCount(0);
			await holdForRecording(page);
		});
	}
);
