// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { modelWithoutTools, pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// "Which model are you, and who runs you?" answered from the system prompt's own provenance
// facts and still showed "searched the web · 7 sources" (CUR-2038). Under the margin
// strategy the embedding gate is the only decider, and its nearest exemplar was the fresh "How do you
// find out which model is newest?". Two self-identity phrasings are now evergreen exemplars in the
// train split (evals/search-decision/cases.jsonl), so the gate answers these from what it knows.
//
// Each turn reads the STORED message rather than the chip: `webSearch` is set only when a search
// grounded the turn, and `searchAttempt.searched` says whether a round-trip to the engines ran at all
// (Message.ts). The control asserts the round-trip, not grounding, so a relevance-bar miss on news
// does not read as the gate declining.
//
// The live log's "Searching the web…" line comes from the `phase:searching` marker, which must not
// be sent before the gate decides, or a declined turn flashes it anyway.
// A DOM observer installed before the page loads records every line the live log renders,
// since they are gone by the time the turn ends. A web line must appear only on a turn that searches
// the web, and a turn that looks only in our own documents says so instead (CUR-2223).
//
// Preview-only: the gate flag is forced through the fuzz_override cookie, which production refuses.

type Stored = {
	id: string;
	rag?: { sources?: unknown[] };
	webSearch?: { sources?: unknown[] };
	searchAttempt?: { searched: boolean };
	rungs?: { rung: string; outcome?: string }[];
};

/** A live line that says a web search is running: "Searching the web…", or a screening line naming it. */
const WEB_LINE = /searching (our documents and )?the web/i;

async function askOnce(
	page: Page,
	question: string,
	entry: string = chatEntry()
): Promise<{ stored: Stored; text: string; liveLines: string[]; searchingShown: boolean }> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// Only the live log's own lines, so an answer that mentions the web in its prose cannot count.
	await page.addInitScript(() => {
		const w = window as unknown as { __liveLines?: string[] };
		w.__liveLines = [];
		new MutationObserver(() => {
			for (const log of document.querySelectorAll(
				'[data-message-role="assistant"] [aria-live="polite"]'
			)) {
				for (const line of (log as HTMLElement).innerText.split('\n')) {
					const t = line.trim();
					if (t && !w.__liveLines!.includes(t)) w.__liveLines!.push(t);
				}
			}
		}).observe(document, { childList: true, subtree: true, characterData: true });
	});
	await page.goto(entry, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(question);
	await composer.press('Enter');

	const message = page.locator('[data-message-role="assistant"]').first();
	await expect(
		turnDone(message),
		`"${question}" never finished within 60s` + warmupContext()
	).toBeVisible({ timeout: 60_000 });
	await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	expect(conversationId, `no conversation id in ${page.url()}`).not.toBe('');

	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await message.getAttribute('data-message-id');
	const stored = body.json?.messages?.find((m) => m.id === id);
	expect(
		stored,
		`the page shows message ${id}, which is not in the stored conversation`
	).toBeTruthy();
	const liveLines = await page.evaluate(
		() => (window as unknown as { __liveLines?: string[] }).__liveLines ?? []
	);
	return {
		stored: stored!,
		text: await message.innerText(),
		liveLines,
		searchingShown: liveLines.some((l) => WEB_LINE.test(l))
	};
}

test(
	'asked which model it is and who runs it, Alpha does not search the web',
	{ tag: ['@preview-only', '@CUR-2038'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const { stored, text, liveLines, searchingShown } = await askOnce(
			page,
			'Which model are you, and who runs you?'
		);
		expect(
			stored.webSearch,
			`an identity question grounded on ${stored.webSearch?.sources?.length} web sources`
		).toBeUndefined();
		expect(
			stored.searchAttempt?.searched ?? false,
			'an identity question made a round-trip to the search engines'
		).toBe(false);
		expect(text, 'the receipt claims a web search on an identity question').not.toMatch(
			/searched the web/
		);
		expect(
			searchingShown,
			`the live log said the web was being searched on a turn the gate declined: ${JSON.stringify(liveLines)}`
		).toBe(false);
	}
);

// X-ray's "This answer" receipt read "Searched the web but found nothing reliable" on a turn
// whose stored searchAttempt was {searched: false}: the decider declined and no search ran (CUR-2657). The turn
// has to carry a declined attempt for this to test anything, so that is asserted first. The gate runs
// only on the scaffolded harness; a native turn lets the model decide and stores no attempt (CUR-2734),
// so the turn is pinned to a model without tools, which always gets the scaffolded plan (CUR-4015).
test(
	"when the gate declines a search, X-ray's receipt says it decided against one, never that one ran",
	{ tag: ['@preview-only', '@CUR-2657'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const { stored } = await askOnce(
			page,
			'Which model are you, and who runs you?',
			pinnedChatEntry((await modelWithoutTools(page.request)).id)
		);
		expect(
			stored.searchAttempt,
			'the turn stored no declined search attempt, so it cannot show the declined wording'
		).toMatchObject({ searched: false });

		await page
			.locator('[data-message-role="assistant"]')
			.first()
			.getByRole('button', { name: /How this answer was made/ })
			.click();
		await page.getByRole('tab', { name: 'This answer' }).click();
		const receipt = page.locator('[data-answer-receipt]');
		await expect(receipt, 'the receipt does not say the search was decided against').toContainText(
			'Decided a web search wasn’t needed',
			{ timeout: 15_000 }
		);
		await expect(
			receipt,
			'the receipt says a search ran on a turn that never searched'
		).not.toContainText('Searched the web but found nothing reliable');
	}
);

// A QA question about where the product runs searched on 9 of 10 turns (CUR-2135), the gate's
// nearest exemplars being fresh "where is X running" lookups.
test(
	'asked who serves it and where the answer runs, Alpha does not search the web',
	{ tag: ['@preview-only', '@CUR-2135'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const turn = await askOnce(page, 'Who serves you, and where does this answer run?');
		expect(
			{ searched: turn.stored.searchAttempt?.searched ?? false, grounding: turn.stored.webSearch },
			'a question about where Alpha runs was sent to the search engines, or grounded on web sources'
		).toEqual({ searched: false, grounding: undefined });
		expect(turn.text, 'the receipt claims a web search on a question about Alpha').not.toMatch(
			/searched the web/
		);
		expect(
			turn.searchingShown,
			`the live log announced a web search the gate declined: ${JSON.stringify(turn.liveLines)}`
		).toBe(false);
	}
);

// Asked in French (CUR-2135), the same question searched every time and was
// answered about a Quebec campaign named "Quel modèle es-tu ?". The gate's exemplars are English; the
// multilingual self-identity verdict now vetoes the search, so the stamp flag is forced on with it.
// Spanish did not search before the fix, so it passes either way.
for (const [lang, question] of [
	['French', 'Quel modèle es-tu, et qui le fait tourner ?'],
	['German', 'Welches Modell bist du, und wer betreibt dich?']
] as const) {
	test(
		`asked in ${lang} which model it is and who runs it, Alpha does not search the web`,
		{ tag: ['@preview-only', '@CUR-2135'] },
		async ({ page, context, baseURL }) => {
			test.setTimeout(120_000);
			await setFlagOverrides(context, baseURL!, {
				'search-intent-embedding-gate': true,
				'identity-provider-stamp': true
			});
			const turn = await askOnce(page, question);
			expect(
				{
					searched: turn.stored.searchAttempt?.searched ?? false,
					grounding: turn.stored.webSearch
				},
				`a ${lang} question about Alpha was sent to the search engines, or grounded on web sources`
			).toEqual({ searched: false, grounding: undefined });
			expect(
				turn.searchingShown,
				`the live log announced a web search on a ${lang} identity question: ${JSON.stringify(turn.liveLines)}`
			).toBe(false);
		}
	);
}

test(
	'asked for this week’s news, Alpha still searches the web',
	{ tag: ['@preview-only', '@CUR-2038'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const { stored, liveLines, searchingShown } = await askOnce(
			page,
			"What's the latest news on the EU AI Act?"
		);
		expect(
			!!stored.webSearch || stored.searchAttempt?.searched === true,
			`a news question never reached the search engines (webSearch ${!!stored.webSearch}, searchAttempt ${JSON.stringify(stored.searchAttempt)})`
		).toBe(true);
		expect(
			searchingShown,
			`a turn that searched never said it was searching the web: ${JSON.stringify(liveLines)}`
		).toBe(true);
	}
);

// The original report (CUR-2038): a letter request showed "Searching the open web". Its margin sat
// at +0.007 against the -0.0179 threshold, and a sales-tax total at +0.064, so both searched. Everyday
// drafts and arithmetic totals now have evergreen exemplars, and a tax-RATE lookup a fresh one so that
// "what is the sales tax in Texas" still searches. Neither question below is one of those exemplars.
test(
	'asked to write a letter that needs no lookup, Alpha does not search the web',
	{ tag: ['@preview-only', '@CUR-2038'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const turn = await askOnce(
			page,
			'Write a letter to my landlord asking him to fix the heating.'
		);
		expect(
			{ searched: turn.stored.searchAttempt?.searched ?? false, grounding: turn.stored.webSearch },
			'a letter request was sent to the search engines, or grounded on web sources'
		).toEqual({ searched: false, grounding: undefined });
		expect(
			turn.searchingShown,
			`the live log announced a web search on a letter request: ${JSON.stringify(turn.liveLines)}`
		).toBe(false);
	}
);

test(
	'a shopping total answered by math routing shows no web search',
	{ tag: ['@preview-only', '@CUR-2038'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, {
			'search-intent-embedding-gate': true,
			'math-routing': true
		});
		// The planner runs only on the scaffolded harness, so pin a model without tools, as
		// math-routing.spec.ts does; the default model runs the native one, which plans nothing.
		const turn = await askOnce(
			page,
			'I bought 3 notebooks at $4.75 each, 2 pens at $1.20 each, and a backpack for $38.50. Sales tax is 8.25%. What is my total?',
			pinnedChatEntry((await modelWithoutTools(page.request)).id)
		);
		// The subject is a math-routed turn, so a turn the planner did not route says nothing about one.
		const plan = turn.stored.rungs?.find((r) => r.rung === 'math-route');
		expect(
			plan?.outcome,
			`the turn was not answered by math routing (rungs ${JSON.stringify(turn.stored.rungs)})`
		).toBe('ok');
		expect(
			{ searched: turn.stored.searchAttempt?.searched ?? false, grounding: turn.stored.webSearch },
			'a math-routed shopping total was sent to the search engines, or grounded on web sources'
		).toEqual({ searched: false, grounding: undefined });
		expect(turn.text, 'the receipt claims a web search on a shopping total').not.toMatch(
			/searched the web/
		);
	}
);

test(
	'asked about a product in our catalog, Alpha says it is searching our documents, not the web',
	{ tag: ['@preview-only', '@CUR-2223'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'search-intent-embedding-gate': true });
		const { stored, liveLines, searchingShown } = await askOnce(
			page,
			'What does OpenGuardrails do?'
		);
		// The control has to be a document-only turn, or the assertions below say nothing about one.
		expect(
			stored.rag?.sources?.length ?? 0,
			'the turn found nothing in our documents, so it is not a document-only turn'
		).toBeGreaterThan(0);
		expect(
			stored.searchAttempt?.searched ?? false,
			'the turn also searched the web, so it is not a document-only turn'
		).toBe(false);
		expect(
			liveLines.some((l) => /searching our documents/i.test(l)),
			`the live log never said it was searching our documents: ${JSON.stringify(liveLines)}`
		).toBe(true);
		expect(
			searchingShown,
			`the live log said the web was being searched on a document-only turn: ${JSON.stringify(liveLines)}`
		).toBe(false);
	}
);
