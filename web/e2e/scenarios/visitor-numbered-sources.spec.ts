// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// A visitor who pastes their own numbered sources, "[1] …" and "[2] …", and asks for a cited
// answer expects the answer's [1] and [2] to mean those (CUR-3844). With search off, the no-source guard deleted
// them as fabricated; with search on, our results took [1] and [2] and the visitor's markers linked to
// web pages they never gave. The server now numbers its sources after the visitor's and the renderer
// shows the visitor's markers as plain text.
//
// What each turn asserts is the part the server owns: no stored source takes [1] or [2], and no [1] or
// [2] in the answer is a link. Whether the model chose to cite is recorded as an annotation, and the
// search-off turn also requires at least one of the visitor's markers to survive.

const SOURCES = [
	'[1] Open weights let independent researchers audit a model for bias and safety problems.',
	'[2] Public data commons let smaller labs train and compare models without licensing costs.'
];

// Search off: the answer can draw only on the visitor's two sources.
const OFF_PROMPT = [
	'Using only the two sources below, write two sentences on why open model weights matter. Cite each sentence by its source number.',
	'',
	...SOURCES
].join('\n');

// Search on: the instruction alone retrieved nothing on the first CI run (the reranker kept no page for
// "using only the two sources below"), so this asks for this week's EU AI Act news as well, the topic
// searched-answer-citations.spec.ts retrieves sources for.
const ON_PROMPT = [
	"What's the latest news on the EU AI Act this week? Add two sentences on why open model weights matter, citing the two sources below by their numbers.",
	'',
	...SOURCES
].join('\n');

type Stored = {
	id: string;
	content?: string;
	searchAttempt?: unknown;
	webSearch?: { sources: { n: number; url: string }[] };
	rag?: { sources: { n: number }[] };
};

async function askWithSearch(
	page: Page,
	mode: 'off' | 'always',
	prompt: string
): Promise<{ stored?: Stored; id: string }> {
	await page.addInitScript((m) => {
		try {
			localStorage.setItem('ap:webSearchChoice', m);
			localStorage.setItem('ap:webSearchMode', m);
		} catch {
			// Storage blocked: the stored sources below say which mode the turn actually ran in.
		}
	}, mode);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(`${chatEntry()}?ph_test=live-suite`, { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(prompt);
	await composer.press('Enter');
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const message = page.locator('[data-message-role="assistant"]').last();
	await expect(
		turnDone(message),
		'the turn never finished within 120s' + warmupContext()
	).toBeVisible({
		timeout: 120_000
	});
	const res = await page.request.get(`/chat/api/v2/conversations/${id}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const messageId = await message.getAttribute('data-message-id');
	return { stored: body.json?.messages?.find((m) => m.id === messageId), id };
}

async function linkedVisitorMarkers(page: Page): Promise<string[]> {
	return page
		.locator('[data-message-role="assistant"]')
		.last()
		.locator('a')
		.evaluateAll((links) =>
			links
				.filter((a) => /^\[(1|2)\]$/.test((a.textContent ?? '').trim()))
				.map((a) => `${a.textContent} → ${a.getAttribute('href')}`)
		);
}

async function cleanUp(page: Page, id: string): Promise<void> {
	if (!id) return;
	const origin = new URL(page.url()).origin;
	await page.request.delete(`${origin}/chat/api/v2/conversations/${id}`, { headers: { origin } });
}

test(
	"with search off, the visitor's pasted [1] and [2] survive in the answer as their own sources",
	{ tag: ['@CUR-3844'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		let id = '';
		try {
			const turn = await askWithSearch(page, 'off', OFF_PROMPT);
			id = turn.id;
			const text = turn.stored?.content ?? '';
			test.info().annotations.push({ type: 'answer', description: text.slice(0, 400) });
			expect(
				turn.stored?.webSearch?.sources ?? [],
				'search was off but the turn stored web sources'
			).toHaveLength(0);
			expect(
				text,
				"the answer kept neither of the visitor's [1] or [2]: the no-source guard deleted them, or the model cited nothing"
			).toMatch(/\[(1|2)\]/);
			expect(await linkedVisitorMarkers(page), "a visitor's [1] or [2] rendered as a link").toEqual(
				[]
			);
		} finally {
			await cleanUp(page, id);
		}
	}
);

test(
	"with search on, our sources are numbered after the visitor's [1] and [2], which never link to a result",
	{ tag: ['@CUR-3844'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		let id = '';
		try {
			const turn = await askWithSearch(page, 'always', ON_PROMPT);
			id = turn.id;
			const numbers = [
				...(turn.stored?.rag?.sources ?? []).map((s) => s.n),
				...(turn.stored?.webSearch?.sources ?? []).map((s) => s.n)
			];
			test.info().annotations.push({
				type: 'sources',
				description: JSON.stringify({ numbers, answer: (turn.stored?.content ?? '').slice(0, 400) })
			});
			expect(numbers.length, 'search was "always" but the turn stored no sources').toBeGreaterThan(
				0
			);
			expect(
				numbers.filter((n) => n <= 2),
				`a retrieved source took one of the visitor's numbers (stored: ${JSON.stringify(numbers)})`
			).toEqual([]);
			expect(
				await linkedVisitorMarkers(page),
				"a visitor's [1] or [2] linked to one of our results"
			).toEqual([]);
			// Each of our markers that links goes to a page this turn retrieved.
			const urls = new Set((turn.stored?.webSearch?.sources ?? []).map((s) => s.url));
			const ours = await page
				.locator('[data-message-role="assistant"]')
				.last()
				.locator('a')
				.evaluateAll((links) =>
					links
						.filter((a) => /^\[\d+\]$/.test((a.textContent ?? '').trim()))
						.map((a) => a.getAttribute('href') ?? '')
				);
			expect(
				ours.filter((href) => !urls.has(href)),
				`an [n] marker links to a page the turn did not retrieve (retrieved: ${JSON.stringify([...urls])})`
			).toEqual([]);
		} finally {
			await cleanUp(page, id);
		}
	}
);
