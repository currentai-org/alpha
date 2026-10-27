// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { franc } from 'franc';
import { chatEntry, answerShapeEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { setFlagOverrides } from './helpers/flagOverride';
import type { Locator, Page } from './helpers/test';
import { chromeCopy } from '../../src/lib/chat/chromeCopy';
import { installModelReplay } from './helpers/faultInjection';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// The live request log's lines come and go within a second or two, faster than a locator
// poll can be trusted to catch, so an observer installed before the page loads records every text a
// `[data-live-line]` ever held. Read it once the turn has finished.
async function recordLiveLines(page: Page) {
	await page.addInitScript(() => {
		const seen: string[] = [];
		(window as unknown as { __liveLines: string[] }).__liveLines = seen;
		const read = () => {
			for (const node of document.querySelectorAll('[data-live-line]')) {
				const text = node.textContent?.trim();
				if (text && !seen.includes(text)) seen.push(text);
			}
		};
		new MutationObserver(read).observe(document, {
			subtree: true,
			childList: true,
			characterData: true
		});
	});
	return () => page.evaluate(() => (window as unknown as { __liveLines: string[] }).__liveLines);
}

// Every fixed string in a language's live-log table, plus the stems of the ones that take a model
// name ("X réfléchit…" → "réfléchit…"), so a line can be traced to the table it came from.
function liveLineStems(lang: string): string[] {
	const c = chromeCopy(lang);
	const fixed = [
		c.preparing,
		c.fixedReply,
		c.audio,
		c.screening,
		c.screeningDocuments,
		c.screeningWeb,
		c.screeningDocumentsWeb,
		c.searching,
		c.checking,
		c.calculating,
		c.declined
	];
	const named = [c.generating, c.thinking, c.writing].map((f) =>
		f('\u0000').split('\u0000')[1].trim()
	);
	return [...fixed, ...named];
}

// The two lines that sit directly under an answer, the footer's "How this was made" link and
// the open-gap card, follow the answer's language. They must not show in English under a
// French or Spanish answer (CUR-2394). The link is under every answer a model served, so it is asserted
// outright; the card shows only on a turn that searched the web, so it is read when it is there.
async function expectChromeInAnswerLanguage(
	assistantMessage: Locator,
	expected: { howMade: string; gapAction: string }
) {
	const howMade = assistantMessage.locator('[data-how-made]');
	await expect(
		howMade,
		'no "How this was made" link under a finished answer a model served'
	).toBeVisible({ timeout: 15_000 });
	await expect(
		howMade,
		'the "How this was made" link stayed English under an answer in another language'
	).toContainText(expected.howMade);
	await expect(howMade).not.toContainText('How this was made');

	const gap = assistantMessage.locator('[data-gap-invite]');
	if ((await gap.count()) > 0) {
		await expect(
			gap,
			'the open-gap card stayed English under an answer in another language'
		).toContainText(expected.gapAction);
		await expect(gap).not.toContainText(/Open gap|Help build it|open stack/);
	} else {
		test.info().annotations.push({
			type: 'CUR-2394',
			description: 'this turn did not search the web, so no open-gap card to read'
		});
	}
}

// Every visitor in this file writes in a language other than English, so none of their
// browsers sends English first. The Quechua, Yucatec Maya, Tzeltal and Spanish cases are Latin
// American visitors; the French case overrides this below. Playwright's default is en-US, which
// recorded these welcome screens with English prompt chips no such visitor would see.
test.use({ locale: 'es-MX' });

// A2 ("Alpha speaks my language") has no filmed journey at all. A version of "you write in another
// language, Alpha answers in English" was fixed by hand more than once (CUR-672, CUR-706, CUR-1430), and
// a checked-in probe exists for exactly that reason (CUR-1442; scripts/language-turn-probe.mjs,
// franc-based, 20 languages) for exactly that reason. That probe calls the chat API directly; it
// owns detection BREADTH and does not touch a browser. This spec is the other half: drive the real
// composer, in the real UI, and prove the rendered reply is actually in the language asked — the
// thing a person watching the recording would judge the feature by. Not a second detector: it
// reuses `franc` (already a devDependency for the probe above) for the one assertion it needs,
// rather than inventing its own language heuristic.
//
// French, specifically, because CUR-1430 ("Detect French and respond in the same language") closed that
// regression for it, on the most concretely-evidenced case. Latin script also avoids confounding this
// with the separate RTL-rendering question for Arabic (CUR-672).
//
// The question is deliberately generic ("what is artificial intelligence, in one sentence") rather
// than anything about Current AI or public AI. There are two SEPARATE faults here (CUR-706): an English-opener leak
// (what CUR-1430 fixes, and what this spec targets),
// and questions ABOUT Current AI answering from the org's own English catalog via web-search
// grounding (a retrieval-scoping issue, not a language-selection one). A question that can't trigger
// that second path keeps this spec pointed at the one defect it names.
//
// No `setFlagOverrides` and no `@preview-only` tag: unlike sign-in's better-auth-signin flag, "answer
// in the asker's language" is plain, unconditional prompt behavior — no PostHog flag gates it, so
// there is no override to force in both directions the way sign-in.spec.ts does for CUR-1368.
// This spec runs signed out with the agent off, as a visitor would: it needs no auth and
// should mean the same thing on every deployment.
// A French speaker's browser asks for French, so this visit is recorded with one. The
// welcome screen must not show English prompt chips to it.
test.describe('a French browser', () => {
	test.use({ locale: 'fr-FR' });

	test(
		'writing to Alpha in French gets a French reply, rendered on screen',
		{ tag: ['@A2', '@no-replay', '@CUR-1575'] },
		async ({ page }) => {
			// Same overlay hazard as chat-message-send.spec.ts: an async settings load can mount the
			// welcome dialog at any point after first paint, including mid-action. Registered before
			// navigation for the same reason — the dialog can appear on first paint.
			const welcomeDialog = page.locator('[data-welcome]');
			await page.addLocatorHandler(welcomeDialog, async () => {
				await welcomeDialog.locator('[data-welcome-start]').click();
			});

			const liveLines = await recordLiveLines(page);
			await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

			const question = "Explique en une phrase ce qu'est l'intelligence artificielle.";
			const composer = page.locator('[data-chat-input]');
			const assistantMessage = page.locator('[data-message-role="assistant"]').last();
			const answerBody = assistantMessage.locator('.prose');
			await journeyStep(page, 'A2', 1, async () => {
				await composer.click({ timeout: 30_000 });
				// A2 step 1 "feels broken if" the placeholder implies English is expected first (CUR-1575).
				await expect(
					composer,
					'the empty composer asked a French browser in English'
				).toHaveAttribute('placeholder', chromeCopy('fr').placeholder);
				await composer.fill(question);
				await composer.press('Enter');

				// Same 30s budget as chat-message-send.spec.ts, and the same reason: preview runs ~2.5x
				// slower than prod, and this wait isn't the assertion under test.
				await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
				await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });
			});

			await journeyStep(page, 'A2', 2, async () => {
				await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

				// An ANSWER has to exist before anything can be said about its language, and that is a
				// separate fact from the turn having finished. `.prose` is the container ChatMessage.svelte
				// renders each text block into (`proseClasses`, :582) — it holds the answer and nothing
				// else, so the live "Apertus … is working…" indicator, the provenance line and the button
				// labels are all outside it. Waiting on it here means a turn that produced nothing fails
				// with THAT sentence rather than with a claim about language (CUR-1653).
				await expect(
					answerBody.first(),
					'no answer body ever rendered — the turn produced nothing, which is not a language failure'
				).toBeVisible({ timeout: 45_000 });
			});

			await journeyStep(page, 'A2', 3, async () => {
				// The reply streams in token by token, so reading its text immediately would race a partial
				// answer — franc's read on a half-sentence fragment is exactly the short-text confusion its
				// own README warns about, and the probe's header comment (scripts/language-turn-probe.mjs)
				// hits the same limitation. Retry is the completion signal: `ChatMessage.svelte:970` renders
				// it only once `isTurnStillRunning` goes false, and there is one per message. NOT "Copy to
				// clipboard" — every code block renders its own copy button as soon as the fence streams in
				// (`CodeBlock.svelte:63`), so a bubble-scoped wait on that title can resolve mid-stream
				// (CUR-2040). 45s, not 30s: a full generated sentence takes longer than chat-message-send's
				// fixed "2+2" reply.
				await expect(
					assistantMessage.getByRole('button', {
						name: 'Réessayer'
					}),
					'the turn never finished'
				).toBeVisible({ timeout: 45_000 });

				// Read the answer, NOT the bubble. `assistantMessage.innerText()` swept in the working
				// indicator, the provenance line and a button label, all of them English — so franc
				// reported `eng` for a turn that had produced no words at all, and the length guard below
				// passed on that chrome rather than catching the empty answer it exists for.
				const replyText = (await answerBody.allInnerTexts()).join('\n').trim();
				expect(
					replyText.length,
					`assistant reply was empty or near-empty: "${replyText}"`
				).toBeGreaterThan(20);

				const detected = franc(replyText, { minLength: 10 });
				expect(
					detected,
					`expected a French reply (franc: "fra") to "${question}", got "${detected}" for: ${replyText}`
				).toBe('fra');
			});

			await expectChromeInAnswerLanguage(assistantMessage, {
				howMade: 'Comment cette réponse a été produite',
				gapAction: 'Aider à la construire'
			});

			// A French browser watches the answer being made in French. Every status line the
			// log showed must come from the French table, and none from the English one.
			const seen = await liveLines();
			expect(
				seen.length,
				'the live request log never showed a line while the answer was made'
			).toBeGreaterThan(0);
			const french = liveLineStems('fr');
			const english = liveLineStems('en');
			for (const line of seen) {
				expect(
					english.some((stem) => line.endsWith(stem)),
					`the live status line was English for a French browser: "${line}"`
				).toBe(false);
				expect(
					french.some((stem) => line.endsWith(stem)),
					`the live status line is in no table French uses: "${line}" (seen: ${seen.join(' | ')})`
				).toBe(true);
			}
		}
	);
});

// A2 step 4: "asks in a language Alpha is known to handle badly" gets an honest, pre-stored
// fallback message instead of a confident wrong answer. Gated on `low-resource-language-fallback`
// (CUR-742/CUR-1680) — preview 100%, no production group — so this forces the flag explicitly
// rather than relying on the ambient value, same pattern as sign-in.spec.ts's fuzz-override tests.
//
// The text sent is the real Quechua UDHR title line — languageFallback.spec.ts's own unit test
// already proves this exact string trips
// detectLowResourceLanguage's >=2-distinct-word threshold and resolves to "quz". A short greeting
// does NOT work here — the detector's word table is drawn from the UDHR's legal register, and
// the greetings from CUR-674 ("Napaykullayki. ¿Imaynatam yanapawankiman?") share zero tokens
// with it. Reusing the
// unit test's already-verified string, rather than inventing a second one, is what keeps this
// spec pointed at "does the honest message reach the screen" and not at detector coverage, which
// languageFallback.spec.ts already owns.
//
// Goes red for the reason it names: forcing the override
// to `false` instead of `true` makes the same question fall through to real generation, which
// answers with a different, plausible-sounding non-answer ("I don't have verified information
// about that phrase...") rather than coincidentally matching the fallback text.
test(
	'asking Alpha in Quechua gets the honest low-resource fallback, not a confident wrong answer',
	{ tag: '@A2' },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'low-resource-language-fallback': true });

		const welcomeDialog = page.locator('[data-welcome]');
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.locator('[data-welcome-start]').click();
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const question = 'PACHATIN LLAQTAKUNAPI RUNAQ ALLIN KANANPAQ JATUN KAMACHIKUY';
		const composer = page.locator('[data-chat-input]');
		await journeyStep(page, 'A2', 4, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

			const assistantMessage = page.locator('[data-message-role="assistant"]').last();
			await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

			// The fallback is pre-stored and never generated (languageFallback.ts's own header — the
			// whole point is that it can't hallucinate or leak scaffolding the way asking the model to
			// draft its own disclaimer did, CUR-674) — so this can assert the literal
			// text `lowResourceFallbackMessage('quz')` returns, not just a loose shape. A model-generated
			// reply could not coincidentally reproduce this exact sentence.
			const answerBody = assistantMessage.locator('.prose');
			await expect(
				answerBody.first(),
				'no answer body ever rendered — the turn produced nothing, which is a different failure than a wrong-language answer'
			).toBeVisible({ timeout: 45_000 });
			await expect(answerBody.first()).toContainText(
				// In the browser's language (es-MX here), naming the language in Spanish.
				'Todavía no puedo responder con fiabilidad en quechua: mi entrenamiento en esta lengua es limitado',
				{ timeout: 15_000 }
			);

			// The negative half of the contract: no capability blurb, and no confident answer that
			// happens to open with the fallback's own words then keeps generating past it.
			const replyText = (await answerBody.allInnerTexts()).join('\n').trim();
			expect(
				replyText,
				`the reply leaked the capability blurb instead of the honest fallback: ${replyText}`
			).not.toMatch(/potluck|open source|open-weights/i);
		});

		// No model ran, so the receipt under the notice says that. It must not claim "from
		// training" or "nothing reported which model served it", which describe a generation that never
		// happened. The receipt renders only once the turn has finished, and must survive a reload.
		// In the browser's language too, like the notice above it (CUR-2394).
		const fixedLine = 'Ningún modelo escribió esta respuesta. Es un aviso fijo de Alpha.';
		for (const when of ['live', 'after a reload']) {
			if (when === 'after a reload') await page.reload({ waitUntil: 'commit' });
			const message = page.locator('[data-message-role="assistant"]').last();
			await expect(
				message.locator('[data-provenance="fixed"]'),
				`${when}: the notice does not say that no model wrote it`
			).toHaveText(fixedLine, { timeout: 45_000 });
			await expect(message.locator('[data-provenance="unavailable"]')).toHaveCount(0);
			await expect(message).not.toContainText('from training');
		}
	}
);

// Two failures (CUR-1841): an ordinary Yucatec Maya sentence got no
// notice, and in Quechua, "Yes, please try anyway" got the notice again instead of an attempt. This drives
// both through the real composer, the second through the notice's own "Try anyway" button. The second turn is a real generation, so it asserts only what the
// fix promises: the reply is not the notice. How good the Quechua is stays the model's problem.
test(
	'an ordinary Yucatec Maya sentence gets the notice, and "try anyway" then gets an attempt, not the notice again',
	{ tag: '@A2' },
	async ({ page, context, baseURL }) => {
		// Two turns, the second a real generation that can take most of a minute on a cold preview.
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'low-resource-language-fallback': true });

		const welcomeDialog = page.locator('[data-welcome]');
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.locator('[data-welcome-start]').click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		// The attempt after "try anyway" must be a real generation with no fixed-notice line, which a canned
		// reply no longer pretends to be (CUR-2954).
		await installModelReplay(page);

		const composer = page.locator('[data-chat-input]');
		const assistantMessages = page.locator('[data-message-role="assistant"]');
		// The notice is in the browser's language, Spanish for this es-MX visitor.
		const notice = 'Todavía no puedo responder con fiabilidad en';

		// The repro from CUR-1841. It holds no word from the detector's list.
		await journeyStep(page, 'A2', 4, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill(
				"Ba'ax ka wa'alik? In k'áat in ts'íibt juntúul carta ti' u láak' in múuch'kabil."
			);
			// No model runs on the notice turn (CUR-1579, CUR-1978), so the live line must never claim one
			// is working. It must not read "The model is working…" up to a notice saying no model wrote it. The
			// line is up for a moment only, so the page records every text it shows until the notice lands.
			await page.evaluate(() => {
				const w = window as unknown as { __modelClaims: string[] };
				w.__modelClaims = [];
				const claim = /[^\n]*\b(is working|is computing|is generating)…/i;
				const obs = new MutationObserver(() => {
					const text = document.body.innerText;
					const m = text.match(claim);
					if (m && !w.__modelClaims.includes(m[0])) w.__modelClaims.push(m[0]);
					if (/no puedo responder con fiabilidad en/i.test(text)) obs.disconnect();
				});
				obs.observe(document.body, { childList: true, subtree: true, characterData: true });
			});
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(assistantMessages.first().locator('.prose').first()).toContainText(
				`${notice} maya yucateco`,
				{ timeout: 45_000 }
			);
			expect(
				await page.evaluate(() => (window as unknown as { __modelClaims: string[] }).__modelClaims),
				'the live line said a model was working on a turn no model answers'
			).toEqual([]);
		});

		// Sent this quickly (CUR-1978), "try anyway" can land while the notice turn was still
		// awaiting its post-turn refresh, and that refresh's snapshot (taken before this message existed)
		// replaces the thread mid-turn: the message vanishes, and the notice sits under this turn's
		// "is generating…" log until the turn ends. The swap is transient, so the page records every
		// state it passes through and the test reads the record once the turn is over.
		await page.evaluate(() => {
			const w = window as unknown as { __tryAnywayGaps: string[] };
			const gaps = new Set<string>();
			let sent = false;
			const check = () => {
				const users = document.querySelectorAll('[data-message-type="user"]').length;
				if (users >= 2) sent = true;
				if (!sent) return;
				if (users < 2) gaps.add(`the "try anyway" message left the screen (${users} user message)`);
				const notice = document.querySelector('[data-message-role="assistant"]');
				if (notice && !notice.querySelector('[data-provenance="fixed"]'))
					gaps.add('the notice lost its fixed-notice line, so it was being shown as a live turn');
				w.__tryAnywayGaps = [...gaps];
			};
			w.__tryAnywayGaps = [];
			new MutationObserver(check).observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true
			});
		});
		// The visitor takes the notice's offer with the button under it, in their own language,
		// rather than having to work out that typing a reply is the way to say yes.
		const tryAnyway = assistantMessages
			.first()
			.getByRole('button', { name: 'Intentarlo de todos modos' });
		await expect(
			tryAnyway,
			'the notice offers to try anyway but has no button to accept'
		).toBeVisible();
		await tryAnyway.click();
		await expect(page.locator('[data-message-type="user"]').nth(1)).toContainText(
			'Inténtalo de todos modos, por favor.'
		);
		await expect(assistantMessages).toHaveCount(2, { timeout: 30_000 });
		// Retry is the "this answer is finished" signal (see the French test above), so the assertion
		// below reads the whole reply rather than its first streamed words.
		await expect(
			assistantMessages.nth(1).getByRole('button', { name: 'Reintentar' }),
			'the attempt never finished'
		).toBeVisible({ timeout: 90_000 });
		// An interrupted reply shows Retry too, so the wait above is also satisfied by one
		// sentence and "Response was interrupted". That can pass while the pre-generation
		// classifiers eat most of the 45s budget and the attempt the person asked for never arrives (CUR-2008).
		await expect(
			// Substring, not exact: the notice's element also holds its Reintentar button, so an exact
			// match could never find it and this check could never fail.
			assistantMessages.nth(1).getByText('La respuesta se interrumpió'),
			'the attempt was cut off before it finished'
		).toHaveCount(0);
		expect(
			await page.evaluate(
				() => (window as unknown as { __tryAnywayGaps: string[] }).__tryAnywayGaps
			),
			'while "try anyway" was answered, the thread on screen went back to the notice turn'
		).toEqual([]);
		// A turn that ends on an error also shows Retry, and has no answer body for the check below to
		// read, so that check would blame the notice for a lane that never answered. Name the error.
		expect(
			await assistantMessages.nth(1).getByRole('alert').allInnerTexts(),
			'the attempt ended on an error instead of an answer'
		).toEqual([]);
		const second = assistantMessages.nth(1).locator('.prose').first();
		await expect(
			second,
			'the second turn repeated the notice instead of attempting an answer'
		).not.toContainText(notice);
		// The "no model wrote this" line belongs to the notice turn only. The attempt is a real
		// generation, and claiming otherwise would be a false provenance statement.
		await expect(assistantMessages.nth(0).locator('[data-provenance="fixed"]')).toBeVisible();
		await expect(
			assistantMessages.nth(1).locator('[data-provenance="fixed"]'),
			'a real generation was labelled as a fixed notice'
		).toHaveCount(0);
	}
);

// The fallback's third language (CUR-2034): the Tzeltal repro from CUR-750, a request for help, which the
// word list cannot match (Tzeltal has no conversational tier) and the trigram tier resolves to `tzh`.
// The notice is pre-stored, so this turn never reaches the model.
test(
	'asking Alpha for help in Tzeltal gets the honest low-resource fallback',
	{ tag: '@A2' },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'low-resource-language-fallback': true });

		const welcomeDialog = page.locator('[data-welcome]');
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.locator('[data-welcome-start]').click();
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.locator('[data-chat-input]');
		await journeyStep(page, 'A2', 4, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill("Bin ut'il ya xju' ya akoltayon?");
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const answerBody = page.locator('[data-message-role="assistant"]').last().locator('.prose');
			await expect(
				answerBody.first(),
				'no answer body ever rendered — the turn produced nothing, which is a different failure than a missed notice'
			).toBeVisible({ timeout: 45_000 });
			await expect(
				answerBody.first(),
				'a Tzeltal request for help did not get the Tzeltal notice'
			).toContainText(
				'Todavía no puedo responder con fiabilidad en tseltal: mi entrenamiento en esta lengua es limitado',
				{
					timeout: 15_000
				}
			);
		});
	}
);

// The other direction (CUR-2034). With the fallback forced ON, a language Alpha serves must not get the
// notice, and must be answered in that language. Spanish because the notice itself points people to it.
// A false positive here costs more than a miss (languageFallback.ts's own trigram-tier comment): it
// hands a Spanish speaker a canned "I can't answer" where they would otherwise get an answer.
test(
	'with the fallback on, a Spanish question gets a Spanish answer rather than the notice',
	{ tag: '@A2' },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'low-resource-language-fallback': true });

		const welcomeDialog = page.locator('[data-welcome]');
		await page.addLocatorHandler(welcomeDialog, async () => {
			await welcomeDialog.locator('[data-welcome-start]').click();
		});
		await page.goto(answerShapeEntry(), { waitUntil: 'commit' });

		const question = '¿Me puedes explicar en una frase qué es la inteligencia artificial?';
		const composer = page.locator('[data-chat-input]');
		await composer.click({ timeout: 30_000 });
		await composer.fill(question);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

		const assistantMessage = page.locator('[data-message-role="assistant"]').last();
		const answerBody = assistantMessage.locator('.prose');
		await expect(
			answerBody.first(),
			'no answer body ever rendered — the turn produced nothing, which is not a language failure'
		).toBeVisible({ timeout: 45_000 });
		// Same completion signal and the same reason as the French test above.
		await expect(
			assistantMessage.getByRole('button', {
				name: 'Reintentar'
			}),
			'the turn never finished'
		).toBeVisible({ timeout: 45_000 });

		const replyText = (await answerBody.allInnerTexts()).join('\n').trim();
		expect(
			replyText,
			`a Spanish question got the low-resource notice, so the detector flagged a language Alpha serves: ${replyText}`
		).not.toContain('Todavía no puedo responder con fiabilidad en');
		expect(
			replyText.length,
			`assistant reply was empty or near-empty: "${replyText}"`
		).toBeGreaterThan(20);
		const detected = franc(replyText, { minLength: 10 });
		expect(
			detected,
			`expected a Spanish reply (franc: "spa") to "${question}", got "${detected}" for: ${replyText}`
		).toBe('spa');

		await expectChromeInAnswerLanguage(assistantMessage, {
			howMade: 'Cómo se hizo esta respuesta',
			gapAction: 'Ayuda a construirlo'
		});
	}
);

// Every graded starter prompt is English (starterShelf.ts), so a visitor whose browser
// asks for another language first is offered none, instead of English chips that read as "English
// is expected here". The English half is the positive control: without it, a welcome screen that
// lost its chips for everyone would pass the French half.
test.describe("the welcome screen's prompt chips follow the browser language", () => {
	for (const [locale, offered] of [
		['fr-FR', false],
		['en-US', true]
	] as const) {
		test.describe(locale, () => {
			test.use({ locale });

			test(
				offered
					? 'an English browser is offered the prompt chips'
					: 'a French browser is offered no English prompt chips',
				{ tag: '@A2' },
				async ({ page }) => {
					const welcomeDialog = page.locator('[data-welcome]');
					await page.addLocatorHandler(welcomeDialog, async () => {
						await welcomeDialog.locator('[data-welcome-start]').click();
					});
					await page.goto(chatEntry(), { waitUntil: 'commit' });

					// The composer rendering means the empty state has rendered, so an absent heading is
					// a real absence rather than a page that has not painted yet.
					await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 30_000 });
					const heading = page.getByText('Prompt examples:');
					if (offered) {
						await expect(heading).toBeVisible();
					} else {
						await expect(heading).toHaveCount(0);
						await expect(page.getByText('Exemples de questions :', { exact: true })).toHaveCount(0);
					}
				}
			);
		});
	}
});
