// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { pinnedChatEntry, type ServedModel } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { openStepByStep } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

// With `native-calculate-tool` on, a model that can call tools works a number out with the
// `calculate` tool, and the turn shows the expression it evaluated and the result under the answer
// (CalculationNote.svelte), so a reader can check the arithmetic rather than trust the prose. Pinned to
// Mistral Large 4, which calls tools natively. A picked model is answered by itself or ends on the busy
// notice (CUR-4383), so the turn is Large 4's.
//
// Preview-only: the flag is forced through the fuzz_override cookie, which production refuses.
const MODEL = LARGE4_MODEL;

test(
	'with native-calculate-tool on, a budget question pinned to Large 4 shows the evaluated expression and the right total',
	{ tag: ['@preview-only', '@CUR-2273'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(140_000);
		await setFlagOverrides(context, baseURL!, { 'native-calculate-tool': true });

		// A target that does not list Large 4 as tool-capable never offers the tool, and the turn would fail
		// below for a reason that has nothing to do with the note. Say so here instead.
		const res = await page.request.get('/chat/api/v2/models');
		expect(res.ok(), `/chat/api/v2/models answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as { json?: ServedModel[] } | ServedModel[];
		const models = Array.isArray(body) ? body : (body.json ?? []);
		expect(
			models.find((m) => m.id === MODEL)?.supportsTools,
			`${MODEL} is not listed with tools on this target: ${JSON.stringify(models.map((m) => [m.id, m.supportsTools]))}`
		).toBe(true);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry(MODEL), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		const message = page.locator('[data-message-role="assistant"]').first();
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			"3 workshops. Each has 14 people, lunch costs €18 per person, and we also pay €240 room hire per workshop. What's the total budget? Show the steps."
		);
		await composer.press('Enter');
		await expect(
			turnDone(message),
			'the budget answer never finished within 60s' + warmupContext()
		).toBeVisible({ timeout: 60_000 });

		const calculations = message.getByTestId('calculation');
		await expect(
			calculations.first(),
			`the turn shows no calculate note, so the model answered without the tool: "${(await message.innerText()).slice(0, 500)}"`
		).toBeVisible();
		const notes = await calculations.allInnerTexts();
		// (3 * 14 * 18) + (3 * 240) = 1476. The note must carry an expression and its evaluated result, not
		// "(empty)" or "could not be worked out".
		expect(
			notes.some((n) => /\S.*[*\u00d7+].*=\s*1,?476(\.0+)?\s*$/.test(n.trim())),
			`no calculate note evaluates the budget to 1476: ${JSON.stringify(notes)}`
		).toBe(true);
		// Once a call evaluated, a call the tool refused is left out of the note.
		expect(
			notes.filter((n) => /could not be worked out/.test(n)),
			`the note shows a refused call beside an evaluated one: ${JSON.stringify(notes)}`
		).toEqual([]);

		const text = await message.innerText();
		expect(text, `the answer does not state the 1,476 total: "${text.slice(0, 500)}"`).toMatch(
			/1[,.\u202f\u00a0 ]?476\b/
		);

		// X-ray's Step by step lists every step that happened, so a turn whose answer is captioned
		// as worked out with a calculator has a calculator step, carrying the same evaluated sum.
		await openStepByStep(page, message, {
			disclosure: { timeout: 15_000 },
			tab: { timeout: 15_000 }
		});
		const calculatorStep = page.locator('[data-step-by-step] li[data-step-id="calculator"]');
		await expect(
			calculatorStep,
			"X-ray's Step by step lists no calculator step under an answer worked out with one"
		).toBeVisible({ timeout: 15_000 });
		await expect(
			calculatorStep,
			'the calculator step does not carry the evaluated total'
		).toContainText(/=\s*1,?476/);

		// Record which model served, and fail on any other, which this spec says nothing about.
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		const stored = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		const conv = (await stored.json()) as {
			json?: { messages?: Array<{ from: string; routerMetadata?: { model?: string } }> };
		};
		const served = (
			(conv.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)?.routerMetadata
				?.model ?? ''
		).toLowerCase();
		test.info().annotations.push({ type: 'served by', description: served || '(not recorded)' });
		expect(
			served,
			'the turn was answered by a model other than the Large 4 that was picked'
		).toMatch(/mistral-large-(2610|4)/);
	}
);
