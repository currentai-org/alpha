// e2e-product: @chat
// e2e-area: @models @provenance
import { test, expect, type Locator, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { phrase } from './helpers/text';
import { warmupContext } from './helpers/warmup';
import { pinnedChatEntry } from './helpers/servedModel';
import { installFaultInjectionHeader, installModelReplay } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';
import { backendHost, laneVendor } from '../../src/lib/chat/servingProvenance';

// F6 ("Users can see where Alpha runs and who runs it").
//
// F6's own description is why this is a journey and not a badge: "the app host is the last non
// sovereign piece of the user visible stack, so this is the infrastructure half of the provenance
// story." Four of the epic's five milestones answer "what people should see" with "Nothing." — the
// Vercel migration, secrets hygiene and security hardening are verified by the numbered tests in
// their own descriptions (deploy a pod with an egress policy, try to push to main), none of which a
// browser can run. This file walks only the user-visible half, and docs/journeys/f6-where-alpha-runs.md
// says so explicitly so a green here is never read as a green on the host migration.
//
// The status-page half needs no generation, so keeping it in its own test leaves a real verdict on
// a day when turns are stalling (CUR-1600). Folded into one test, the whole journey would go
// unmeasurable whenever the serving lane hangs.

test(
	'the status page is reachable from inside Alpha and named, so a user can tell our outage from their network',
	{ tag: ['@F6', '@live'] },
	async ({ page }) => {
		await journeyStep(page, 'F6', 5, async () => {
			await page.goto('/chat/settings/personalization', { waitUntil: 'commit' });

			// The milestone's own words for what people should see: "Maria hits an error. She can find
			// out from the status page whether it is her or us." Named in the UI rather than reached by
			// typing a URL — a status page nobody can find from inside the product answers nobody.
			const statusLink = page.getByRole('link', { name: phrase('Status page') });
			await expect(
				statusLink,
				'nothing inside Alpha points at a status page, so a user hitting an error has no way to tell our outage from their own network'
			).toBeVisible({ timeout: 30_000 });

			// Asserting the destination, not just that a link exists — a "Status page" link pointing
			// anywhere else would pass a visibility check while answering a different question.
			await expect(statusLink).toHaveAttribute('href', /status\.aipotluck\.org/);
		});
	}
);

test(
	'an answer accounts for where it came from, and any provenance it does show never dresses a guess as a reading, reading the same live as after a reload, with X-ray opening below the answer footer (CUR-3963, CUR-3951)',
	{ tag: '@F6' },
	async ({ page }) => {
		// The welcome dialog can mount at any point after first paint and makes the rest of the page
		// inert while it is up — see chat-message-send.spec.ts for the full reasoning and the two
		// earlier attempts that lost that race. Registered before the navigation.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		// The answer's model bytes come from a committed recording (SOL-92); the routing record, the
		// badge and every check below run for real on them. With no recording for this request the turn
		// is live and recorded for `pnpm replay:harvest`.
		test.info().annotations.push({
			type: 'SOL-92',
			description: (await installModelReplay(page))
				? 'model calls replayed'
				: 'live (no fault token)'
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		const assistantMessage = page.locator('[data-message-role="assistant"]').last();
		const { provenance, unavailable } = await journeyStep(page, 'F6', 1, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill('Name the capital of Japan in one sentence.');

			// The first answer's "Energy this session" bloom used to render INSTEAD of the session
			// bar for three seconds, so a control in that bar vanished after every first answer (CUR-1826). "Forget
			// everything" now lives in Settings; the bar's own control is the session footprint. Watch every render
			// from here on and note any moment the button is not showing, plus when the bloom comes and goes,
			// so the check below can wait for the bloom to finish instead of sleeping. Installed before
			// Enter because the navigation to the conversation keeps the layout, and with it this observer.
			await page.evaluate(() => {
				const w = window as unknown as {
					__cur1826: { missing: number; bloom: boolean; bloomGone: boolean };
				};
				w.__cur1826 = { missing: 0, bloom: false, bloomGone: false };
				const look = () => {
					const forget = [
						...document.querySelectorAll<HTMLElement>('[data-footprint-trigger]')
					].some((b) => b.offsetParent !== null);
					if (!forget) w.__cur1826.missing++;
					const bloom = /energy this session/i.test(document.body.innerText);
					if (bloom) w.__cur1826.bloom = true;
					else if (w.__cur1826.bloom) w.__cur1826.bloomGone = true;
				};
				new MutationObserver(look).observe(document.body, {
					subtree: true,
					childList: true,
					characterData: true
				});
			});
			await composer.press('Enter');

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

			await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

			// CopyToClipBoardBtn is the app's own "this answer is done" signal, and ChatMessage.svelte
			// gates the provenance trace on the SAME condition (`!isLast || !loading`), so waiting here
			// waits on the badge's own gate rather than on a proxy for it. Same 45s as the A2 journey.
			//
			// The message names the stall rather than the badge, because a turn that never completed says
			// nothing about provenance and a reader who sees "no provenance line" would chase the wrong
			// defect (CUR-1600).
			await expect(
				assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true }),
				'no completed answer arrived within 45s, so nothing below about provenance was exercised — this is a statement about the serving lane, not about whether the badge is honest' +
					warmupContext()
			).toBeVisible({ timeout: 45_000 });

			// CUR-1826, read once the bloom has run its course. A bloom that never showed is not this
			// defect, so the wait is bounded and the verdict below only reads the button.
			await page
				.waitForFunction(
					() => (window as unknown as { __cur1826: { bloomGone: boolean } }).__cur1826.bloomGone,
					undefined,
					{
						timeout: 10_000
					}
				)
				.catch(() => undefined);
			const bar = await page.evaluate(
				() => (window as unknown as { __cur1826: { missing: number; bloom: boolean } }).__cur1826
			);
			expect(
				bar.missing,
				`the session footprint left the page during the turn (${bar.missing} renders without it; bloom seen: ${bar.bloom}). A control that disappears after the answer reads as broken`
			).toBe(0);

			// STEP 1-3, PARAMETERIZED BY ENVIRONMENT RATHER THAN INTERSECTED ACROSS THEM.
			//
			// Preview never receives the gateway's provenance headers (CUR-1606), so a single clause cannot hold in
			// both environments. Weakening it until it passed in both would leave a test that cannot go red for a
			// provenance defect, in a file whose whole subject is provenance. Each environment gets its own assertion.
			//
			// Intersecting assertions makes the weakest environment the ceiling for every other one. The
			// contract below is the same in both places and each side of it can fail: an answer either names
			// what served it, or says in words that nothing reported it. Silence is the one outcome neither
			// branch permits, and silence is exactly what shipped.
			return await expectAnAccountOfWhereItCameFrom(assistantMessage);
		});

		// The first web-grounded answer carries an "open gap → get involved" invitation (CUR-1873). It is
		// not a fact about this answer, so it must not read as part of the provenance readout it sits
		// under: it is its own note, holds no provenance line, and its sentence ends before the call to
		// action rather than running into it ("…search index get involved →"); the action is "Help build it". Whether the line shows at
		// all depends on the turn searching the web, so this reads whatever gap text the answer has.
		const gapText = assistantMessage.getByText(/open gap/i);
		if ((await gapText.count()) > 0) {
			const note = assistantMessage.getByRole('note', { name: 'An open gap in the stack' });
			await expect(
				note,
				'the open-gap invitation renders as another line of the provenance readout instead of a note of its own'
			).toHaveCount(1);
			await expect(
				note.locator('[title*="served via"], [data-provenance]'),
				'the open-gap note contains the provenance line, so the two still read as one readout'
			).toHaveCount(0);
			expect(
				(await note.innerText()).replace(/\s+/g, ' '),
				'the gap sentence runs straight into its call to action with no stop between them'
			).toMatch(/\.\s*Help build it/);
		} else {
			test.info().annotations.push({
				type: 'CUR-1873',
				description: 'no open-gap line on this answer; nothing to check'
			});
		}

		if ((await provenance.count()) > 0) {
			// The naming branch. Reached wherever the lane reports provenance — production today, and
			// preview the day CUR-1606 lands, with no edit here.
			const badge = provenance.first();
			const line = (await badge.innerText()).trim();
			expect(
				line.length,
				`a provenance line rendered empty, so the badge is present but names nothing: "${line}"`
			).toBeGreaterThan(3);

			// Both branches must not render at once: that would be the page making two contradictory
			// claims about the same answer in the same breath.
			await expect(
				unavailable,
				'the answer names a model AND says no provenance was reported — the page is contradicting itself about the same turn'
			).toHaveCount(0);

			// STEP 3. `measured` separates a per-request report from a fallback guess: the live dot renders
			// on `!traced && measured`, the model name becomes a link to the open weights on
			// `modelCardUrl && measured`. A link without a dot means unmeasured data is wearing the styling
			// of a verified reading — CUR-113 exactly, a wrong backend carrying the confidence of a right
			// one, live for fifteen days.
			if ((await badge.getByRole('link').count()) > 0) {
				await expect(
					badge.locator('span[style*="--ap-live"]'),
					'the model name links out to its open weights while the badge shows no measured marker — an unverified reading is wearing the styling of a verified one, which is the CUR-113 failure'
				).toBeVisible();
			}

			// STEP 2. The weights are one step from the answer: its footer's "How this was made" opens
			// X-ray, whose model row links the model card (`huggingface.co/<org>/<repo>`). A maker link
			// (`huggingface.co/<org>`) alone would pass "has a link" with no way to the weights, which is
			// what happened on Mistral Large 3 until CUR-2283 (CUR-2291). The live page and a reload read
			// routerMetadata by different paths, so both are checked.
			const modelCard = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+$/;
			// The input screen's verdict reached only the database, so X-ray on the live page said
			// "No safety check was recorded" for an answer whose status line had just read "Checking
			// safety…", and a reload said it was checked (CUR-3963). Each read keeps X-ray's safety line to compare.
			const safetyLines: Record<string, string> = {};
			const cardLinks = async (where: string) => {
				await page
					.locator('[data-message-role="assistant"]')
					.last()
					.getByRole('button', { name: /How this answer was made/ })
					.click();
				await page.getByRole('tab', { name: 'This answer' }).click();
				safetyLines[where] = (
					await page.locator('[data-receipt-safety]').innerText({ timeout: 15_000 })
				).trim();
				await page.getByRole('tab', { name: 'The stack' }).click();
				await expectRouteMatchesRecord(where);
				// A stack card cut by the list's top edge (CUR-4123). Measured, not asserted, until the numbers
				// say whether the app's reveal scroll or this spec's own click (Playwright scrolls a target into
				// view first) leaves the list there. Read the `stack-top-edge` annotation and log line.
				const topEdge = (moment: string) =>
					page
						.locator('[data-stack-list]')
						.evaluate((list) => {
							const edge = list.getBoundingClientRect().top;
							const cut = [...list.querySelectorAll('li[data-product-id]')]
								.filter((li) => {
									const r = li.getBoundingClientRect();
									return r.top < edge - 1 && r.bottom > edge + 1;
								})
								.map((li) => {
									const r = li.getBoundingClientRect();
									return `${li.getAttribute('data-product-id')}@${Math.round(r.top - edge)}..${Math.round(r.bottom - edge)}`;
								});
							return `top ${list.scrollTop}/${list.scrollHeight - list.clientHeight}, view ${list.clientHeight}, cut [${cut.join(' ')}]`;
						})
						.then((m) => {
							const description = `${where} ${moment}: ${m}`;
							test.info().annotations.push({ type: 'stack-top-edge', description });
							console.log(`[stack-top-edge] ${description}`);
						});
				// The reveal scrolls the list smoothly, so measure once two reads 250 ms apart agree.
				const scrollTop = () => page.locator('[data-stack-list]').evaluate((l) => l.scrollTop);
				await expect
					.poll(
						async () => {
							const before = await scrollTop();
							await page.waitForTimeout(250);
							return (await scrollTop()) === before;
						},
						{ message: `${where}: the stack list never stopped scrolling`, timeout: 10_000 }
					)
					.toBe(true);
				await topEdge('after the reveal');
				const row = page.locator('li[data-product-id="foundation-model"]');
				const header = row.getByRole('button').first();
				if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
				await topEdge('after the spec opens the model row');
				const hrefs = await row
					.getByRole('link')
					.evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
				expect(
					// The row can link the card twice (its name and its HuggingFace link); one card is the claim.
					[...new Set(hrefs.filter((h) => modelCard.test(h)))],
					`${where}: the answer names "${line}" but X-ray's model row links no model card (links: ${JSON.stringify(hrefs)}), so a user who wants to check the weights has to already know where to look`
				).toHaveLength(1);

				// X-ray is opened to check the answer's footer against it, so the footer stays above
				// the panel once it has opened (CUR-3951). Polled, since the panel eases open.
				const panel = page.locator('[data-accessory-panel="xray"]');
				if (await panel.isVisible()) {
					await expect
						.poll(
							async () => {
								const footer = await page
									.locator('[data-message-role="assistant"]')
									.last()
									.getByRole('button', { name: /How this answer was made/ })
									.boundingBox();
								const top = (await panel.boundingBox())?.y;
								return footer && top !== undefined
									? Math.round(top - (footer.y + footer.height))
									: null;
							},
							{
								message: `${where}: the answer's footer sits under the open X-ray panel, so its claim can't be read beside X-ray's (gap to the panel's top edge, px)`,
								timeout: 5_000
							}
						)
						.toBeGreaterThanOrEqual(0);
				}

				// A link has to look like one before anyone hovers it (CUR-2325): a dotted underline in the
				// same grey as the text around it reads as plain text. At rest means the pointer is off it.
				await page.mouse.move(0, 0);
				const rest = await row.evaluate((el) => {
					const link = [...el.querySelectorAll('a')].find((a) =>
						/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+$/.test(a.getAttribute('href') ?? '')
					);
					if (!link) return null;
					const s = getComputedStyle(link);
					return {
						line: s.textDecorationLine,
						style: s.textDecorationStyle,
						color: s.color,
						around: getComputedStyle(link.parentElement ?? el).color
					};
				});
				expect(
					rest,
					`${where}: the model-card link vanished between two reads of the same row`
				).not.toBeNull();
				expect(
					rest,
					`${where}: at rest the model-card link does not read as a link: ${JSON.stringify(rest)}. It needs a solid underline`
				).toMatchObject({ line: expect.stringContaining('underline'), style: 'solid' });
				expect(
					rest!.color,
					`${where}: the model-card link is the same colour as the text around it, so only the underline marks it`
				).not.toBe(rest!.around);
			};
			// "Where your last message went" names exactly the hosts and region the turn persisted,
			// read back from the conversation API, so the hop list can't show a place the record doesn't hold (CUR-4580).
			const expectRouteMatchesRecord = async (where: string) => {
				const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
				const stored = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
				const rm = (
					(await stored.json()) as {
						json?: {
							messages?: Array<{
								from: string;
								routerMetadata?: { lane?: string; backend?: string; appRegion?: string };
							}>;
						};
					}
				).json?.messages
					?.filter((m) => m.from === 'assistant')
					.at(-1)?.routerMetadata;
				test
					.info()
					.annotations.push({ type: 'route record', description: JSON.stringify(rm ?? null) });
				const route = page.locator('[data-serving-route]');
				await expect(route, `${where}: X-ray shows no "Where your last message went"`).toBeVisible({
					timeout: 15_000
				});
				expect(
					rm?.appRegion,
					`${where}: the turn persisted no appRegion, so X-ray cannot say where the app server ran`
				).toBeTruthy();
				await expect(
					route.locator('[data-hop="app"]'),
					`${where}: the app-server hop names a region the turn did not record`
				).toHaveAttribute('data-hop-source', rm?.appRegion ?? '');
				const lane = rm?.lane;
				const backend = backendHost(rm?.backend);
				const routed = !!lane && !laneVendor(lane) && lane !== backend;
				await expect(
					route.locator('[data-hop="router"]'),
					`${where}: the router hop is ${routed ? 'missing' : 'shown'} for a turn sent to ${lane ?? 'an unrecorded lane'} and answered by ${backend || 'an unrecorded backend'}`
				).toHaveCount(routed ? 1 : 0);
				if (routed) {
					await expect(route.locator('[data-hop="router"]')).toHaveAttribute(
						'data-hop-source',
						lane
					);
					await expect(
						route.locator('[data-hop="router"] [data-hop-place]'),
						`${where}: the router's location is unpublished, so it must say so rather than name a place`
					).toHaveText('location not published');
				}
				await expect(
					route.locator('[data-hop="model"]'),
					`${where}: the model hop names a host the turn did not record`
				).toHaveAttribute('data-hop-source', backend || (laneVendor(lane) ? (lane ?? '') : ''));
				await expect(route.locator('[data-hop="storage"]')).toBeVisible();
			};

			// X-ray closes after the row's span, so F6 row 2's snapshot is the open panel and its link.
			await journeyStep(page, 'F6', 2, async () => {
				await cardLinks('live page');
			});
			await page.keyboard.press('Escape');

			// CUR-2325's link-at-rest check runs inside cardLinks, on X-ray's model row.
			await page.reload({ waitUntil: 'commit' });
			await expect(provenance.first()).toBeVisible({ timeout: 30_000 });
			await cardLinks('after reload');
			await page.keyboard.press('Escape');
			expect(
				safetyLines['live page'],
				`X-ray's safety line on the live page ("${safetyLines['live page']}") differs from the same answer after a reload ("${safetyLines['after reload']}"), so one of the two is not a record`
			).toBe(safetyLines['after reload']);

			// The recording has to end on the conversation, and the conversation has to be
			// there (CUR-2376). A reloaded thread that comes back empty is the failure a person would stop the demo
			// for, and ending on X-ray (or mid-reload) left the gallery unable to tell that apart from a
			// working page. The recording trails the page by 1.8s locally and 3s or more on the gallery
			// runner, so a test that ends inside that window loses its last screens. Close X-ray the way a
			// person would, then assert both sides of the exchange sit inside the viewport.
			// Escape above is how a person closes X-ray; wait for it to have closed.
			await expect(
				page.getByRole('button', { name: 'X-ray — see what happened behind the answer' }),
				'Escape did not close X-ray, so the conversation stays covered'
			).toHaveAttribute('aria-expanded', 'false');
			await expect(
				page.getByText('Name the capital of Japan in one sentence.'),
				'after a reload the question is not on screen, so the conversation reads as gone'
			).toBeInViewport({ timeout: 15_000 });
			await expect(
				assistantMessage.locator('.prose'),
				'after a reload the answer is not on screen, so the conversation reads as gone'
			).toBeInViewport();
		} else {
			// The admission branch. Asserting the WORDS, not just the element, because the element alone
			// could render blank and still satisfy a visibility check — the same vacuous pass this file is
			// here to prevent.
			await expect(
				unavailable,
				'the no-provenance state renders without saying which fact is missing, so a reader learns only that something is absent'
			).toContainText(phrase('which model served it'));
		}
	}
);

async function expectAnAccountOfWhereItCameFrom(assistantMessage: Locator) {
	const provenance = assistantMessage.locator('[data-provenance="line"]');
	const unavailable = assistantMessage.locator('[data-provenance="unavailable"]');
	await expect(
		provenance.or(unavailable).first(),
		'the answer says nothing at all about what served it — not a model, not an admission that nothing reported one. A reader cannot tell "we do not know" from "there is nothing here worth saying", which is the distinction this journey exists to hold'
	).toBeVisible({ timeout: 15_000 });
	return { provenance, unavailable };
}

// The failure F6 is named after is silence, an answer that shows neither a model nor the
// admission that none was reported (CUR-1614). No server fault produces that (stripping the provenance header
// correctly lands on the admission), so the injury hides both readouts with a style tag, the way a
// broken render would. A style rather than removing nodes, because Svelte re-renders them.
test(
	'the provenance check goes red on an answer silent about what served it',
	{ tag: ['@F6', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await silenceTheProvenanceReadout(page);
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of Japan in one sentence.');
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const assistantMessage = page.locator('[data-message-role="assistant"]').last();
		await expect(
			assistantMessage.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'no completed answer arrived within 45s, so the injury was never applied to an answer' +
				warmupContext()
		).toBeVisible({ timeout: 45_000 });

		const error = await expectAnAccountOfWhereItCameFrom(assistantMessage).then(
			() => '',
			(e: Error) => e.message
		);
		test.info().annotations.push({ type: 'injury-proof', description: error.split('\n')[0] });
		expect(error, "F6's provenance check passed on an answer showing no provenance at all").toMatch(
			/says nothing at all about what served it/
		);
	}
);

// An init script waiting for DOMContentLoaded, because addStyleTag straight after a 'commit' goto
// can run before <head> exists and throws on appendChild (seen on both attempts). The
// init script itself runs before <html> exists too, so it cannot append the style directly.
async function silenceTheProvenanceReadout(page: Page) {
	await page.addInitScript(() => {
		// eslint-disable-next-line svelte/no-add-event-listener -- runs in the page, outside any component
		document.addEventListener('DOMContentLoaded', () => {
			const style = document.createElement('style');
			style.textContent = '[title*="served via"], [data-provenance] { display: none !important; }';
			document.head.appendChild(style);
		});
	});
}

// CUR-1614 `wrong_model_served`: the first lane's body names SEA-LION while its headers still name
// Apertus, the swap that put SEA-LION answers under the Apertus badge in September (servedModelPeek.ts).
// Pinned to Apertus because that is the lane it happened on. Since CUR-3936 a picked model is answered
// by itself or not at all; only Mistral Large 3 may fall back, and only to Medium. So the gateway check
// sheds the swap (endpointOai.ts, a 503 once retries run out) and the one passing outcome is the error
// notice: no failover, no served model recorded, and none of SEA-LION's answer on screen. A SEA-LION
// answer under a backup mark fails here like any other substitute. The shed 503 has no busy or timeout
// copy of its own, so the notice is the generic one (upstreamFailed.ts). When Apertus is out of capacity
// the upstream 429 ends the turn on the busy notice before the swap is ever served; that ending keeps
// the same contract (no other model answers in Apertus's place), so it passes too and CI does not wait
// on Apertus capacity.
// Preview-only: the fault switch is never armed on production.
const APERTUS = 'swiss-ai/apertus-v1.5-70b';
const ERROR_NOTICE = /Apertus 1\.5 70B (couldn't answer this time|is busy right now)/i;

test(
	'a substituted answer never carries the badge of the model that was asked for, and no other model answers in its place',
	{ tag: ['@F6', '@preview-only', '@CUR-3936', '@needs-apertus'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await installFaultInjectionHeader(page, 'wrong_model_served');
		await page.goto(pinnedChatEntry(APERTUS), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Quick question ${Date.now()}: name the capital of Japan in one word.`);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText(ERROR_NOTICE),
			'the substituted turn did not end on its error notice' + warmupContext()
		).toBeVisible({ timeout: 120_000 });

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `the conversation API answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{
					from: string;
					routerMetadata?: { model?: string };
					failover?: { from?: string; to?: string };
				}>;
			};
		};
		const answer = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		const served = (answer?.routerMetadata?.model ?? '').toLowerCase();
		test.info().annotations.push({
			type: 'served-under-substitution',
			description: JSON.stringify({ served, failover: answer?.failover })
		});
		expect(
			answer,
			'the conversation stored no assistant message, so every check below would pass on nothing'
		).toBeDefined();
		expect(
			answer?.failover,
			`the turn failed over to ${JSON.stringify(answer?.failover?.to)}, so another model answered for Apertus`
		).toBeUndefined();
		expect(
			served,
			`the turn records ${JSON.stringify(served)} as its served model; a picked Apertus is answered by Apertus or not at all, so a shed turn records none`
		).toBe('');
		await expect(
			reply,
			"SEA-LION's answer to the question reached the visitor in Apertus's place"
		).not.toContainText(/tokyo/i, { timeout: 15_000 });
		await expect(reply, 'the shed turn names SEA-LION').not.toContainText(/sea-lion/i);

		const badge = reply.locator('[data-provenance="line"]');
		await expect(
			badge.filter({ hasText: /apertus/i }),
			'the shed turn still credits Apertus'
		).toHaveCount(0);
		await expect(
			badge.filter({ hasText: /sea-lion/i }),
			'the shed turn credits SEA-LION as a backup'
		).toHaveCount(0);
	}
);

test(
	"an Apertus answer's footer and X-ray name its maker the same way",
	{ tag: ['@F6', '@needs-apertus'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry(APERTUS), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('Name the capital of Switzerland in one sentence.');
		await composer.press('Enter');

		// The footer took the catalog's org name ("Swiss AI Initiative") while X-ray took the
		// model card's ("Swiss National AI Institute"), so one answer credited two different bodies (CUR-1873).
		const reply = page.locator('[data-message-role="assistant"]').last();
		const footer = reply.getByRole('button', { name: /How this answer was made/ });
		await expect(
			footer,
			'the answer never showed its provenance footer' + warmupContext()
		).toBeVisible({
			timeout: 120_000
		});
		const label = (await footer.getAttribute('aria-label')) ?? '';
		const footerMaker = label.match(/ by (.+?)(?:, served as the backup)?\. Opens X-ray\.$/)?.[1];
		test.info().annotations.push({ type: 'footer-label', description: label });
		expect(footerMaker, `the footer names no maker: "${label}"`).toBeTruthy();
		expect(footerMaker, 'the footer credits its maker as a bare abbreviation').not.toMatch(
			/^[A-Z]{2,6}$/
		);

		await footer.click();
		await page.getByRole('tab', { name: 'The stack' }).click();
		const row = page.locator('li[data-product-id="foundation-model"]');
		const header = row.getByRole('button').first();
		if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
		await expect(
			row.locator('[data-xray-partner]'),
			"X-ray's model row names the maker differently from the answer's footer"
		).toContainText(footerMaker!);
		await page.keyboard.press('Escape');
	}
);
