// e2e-product: @chat
// e2e-area: @provenance
import { test, expect, type Page } from './helpers/test';
import type { BrowserContext, Locator } from '@playwright/test';
import { CHAT_ENTRY, LARGE4_MODEL, chatEntry } from './helpers/chatEntry';
import { installBusyScopeHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { openStepByStep, openXrayTab } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

// With the model picker on Auto, Alpha chooses the model in the browser from the message's
// language and size. The conversation POST used to carry only the chosen id, so the answer recorded
// nothing about Auto and X-ray's Step by step could not say Alpha had chosen the model, or why. The
// message now carries Auto's choice, the server keeps it when it names the model the turn ran on, and
// Step by step opens with "Auto chose <model>". A model the person picked themselves gets no such step.

type Stored = { id: string; autoRoute?: { model: string; reasons: string[]; explanation: string } };

// The device's picker choice (routing/choice.ts): `auto`, or a catalog id picked from the list.
const CHOICE_KEY = 'alpha:model-choice';

async function openChat(
	page: Page,
	context: BrowserContext,
	baseURL: string,
	choice: string,
	entry?: string
) {
	await setFlagOverrides(context, baseURL, { 'auto-routing': true });
	// Auto routes around a model marked busy, and a preview's marks outlast the turns that wrote them:
	// a preview whose GLM 5.2 was marked busy kept every later run of the Chinese tests below on
	// Mistral Medium. These tests are about where Auto sends a draft, so they read
	// a fresh busy scope of their own; auto-skips-busy-model.spec.ts covers the marks themselves.
	if (process.env.E2E_FAULT_INJECT_TOKEN) {
		await installBusyScopeHeader(
			page,
			`xray-${test.info().testId}-${test.info().retry}`.slice(0, 64)
		);
	}
	await context.addInitScript(
		([key, value]) => {
			try {
				localStorage.setItem(key, value);
			} catch {
				/* storage unavailable */
			}
		},
		[CHOICE_KEY, choice] as const
	);
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	// Auto is the subject, so a device on Auto enters on the unpinned /chat: `chatEntry()` under the
	// gallery's prod profile is a model link, which picks that model. A picked model keeps
	// the profile's entry.
	await page.goto(entry ?? (choice === 'auto' ? CHAT_ENTRY : chatEntry()), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	return composer;
}

async function ask(page: Page, composer: Locator, question: string, turn = 0): Promise<Locator> {
	await composer.fill(question);
	await composer.press('Enter');
	const answer = page.locator('[data-message-role="assistant"]').nth(turn);
	await expect(
		turnDone(answer),
		`"${question}" never finished within 90s` + warmupContext()
	).toBeVisible({
		timeout: 90_000
	});
	await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	return answer;
}

/** The stored answer, read from the conversation the page is on. */
async function storedTurn(page: Page, answer: Locator): Promise<Stored | undefined> {
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
	const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
	expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
	const body = (await res.json()) as { json?: { messages?: Stored[] } };
	const id = await answer.getAttribute('data-message-id');
	return body.json?.messages?.find((m) => m.id === id);
}

/**
 *  Auto sends this to GLM 5.2 mid-chat, off Mistral Medium, at every size (routing.spec.ts). GLM rather
 *  than SEA-LION v4.8 for Vietnamese: Auto routes around a model its circuit breaker holds busy, and
 *  SEA-LION can be held busy on the preview, so the turn would stay on Medium.
 */
const CHINESE = '中国的首都是哪里？请用一句话回答。';

const xrayTimeouts = {
	expanded: { timeout: 15_000 },
	disclosure: { timeout: 15_000 },
	tab: { timeout: 15_000 }
};

test(
	"an answer whose model Auto chose stores Auto's choice, and X-ray's Step by step says Auto chose it",
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const composer = await openChat(page, context, baseURL!, 'auto');
		const answer = await ask(
			page,
			composer,
			'¿Cuál es la capital de España? Responde en una frase.'
		);

		const stored = await storedTurn(page, answer);
		expect(
			stored?.autoRoute,
			'the answer stored no Auto choice though the picker was on Auto'
		).toBeTruthy();
		test
			.info()
			.annotations.push({ type: 'autoRoute', description: JSON.stringify(stored?.autoRoute) });

		await openStepByStep(page, answer, xrayTimeouts);
		const step = page.locator('li[data-step-id="auto-route"]');
		await expect(step, 'Step by step has no Auto step on an Auto-routed answer').toBeVisible({
			timeout: 15_000
		});
		await expect(step).toContainText(/Auto chose \S/);
	}
);

test(
	'an answer whose model the person picked stores no Auto choice, and Step by step has no Auto step',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const composer = await openChat(page, context, baseURL!, 'mistral-large-4');
		const answer = await ask(page, composer, 'What is the capital of Spain? One sentence.');

		const stored = await storedTurn(page, answer);
		expect(stored, 'the answer was not found in the stored conversation').toBeTruthy();
		expect(stored?.autoRoute, 'a hand-picked model was recorded as chosen by Auto').toBeUndefined();

		await openStepByStep(page, answer, xrayTimeouts);
		// The list itself rendered, so the absent Auto step is not just an unopened panel.
		await expect(page.locator('li[data-step-id="asked"]')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('li[data-step-id="auto-route"]')).toHaveCount(0);
	}
);

test(
	'a model link opened on a device left on Auto picks that model, so the pill names it and the answer claims no Auto choice',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		// The link page sent every message to its model while the pill and the empty state said
		// Auto was choosing, and under the gallery's prod profile every spec enters on such a link.
		const composer = await openChat(
			page,
			context,
			baseURL!,
			'auto',
			`/chat/models/${LARGE4_MODEL}`
		);
		await expect(
			page.locator('[data-model-pill]').first(),
			'the model link left the picker on Auto, though the page sends to the linked model'
		).toHaveAttribute('aria-label', /^Model: Mistral\b/, { timeout: 15_000 });
		const answer = await ask(page, composer, 'What is the capital of Spain? One sentence.');

		const stored = await storedTurn(page, answer);
		expect(stored, 'the answer was not found in the stored conversation').toBeTruthy();
		expect(
			stored?.autoRoute,
			"a model link's answer was recorded as chosen by Auto"
		).toBeUndefined();
	}
);

test(
	"mid-chat, a turn Auto moves to another model stores Auto's choice, though the switch waits on a PATCH",
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const composer = await openChat(page, context, baseURL!, 'auto');
		const first = await ask(
			page,
			composer,
			'¿Cuál es la capital de España? Responde en una frase.'
		);
		const firstStored = await storedTurn(page, first);

		// Chinese moves Auto from Mistral Medium to GLM 5.2 (routing.spec.ts);
		// Catalan stays on Medium. The send awaits the PATCH that switches the conversation. The
		// composer had cleared its draft by then, and Auto's choice with it. Auto decides once the draft has
		// rested 350 ms, and the pill then reads "Auto · <family>": send after that, as a person would.
		await composer.fill(CHINESE);
		await expect(
			page.getByRole('button', { name: /^Model: Auto · / }).first(),
			'mid-chat, Auto never named a model to switch to for the Chinese draft'
		).toBeVisible({ timeout: 15_000 });
		const second = await ask(page, composer, CHINESE, 1);
		const stored = await storedTurn(page, second);
		test.info().annotations.push({
			type: 'autoRoute per turn',
			description: JSON.stringify([firstStored?.autoRoute?.model, stored?.autoRoute?.model])
		});
		expect(
			stored?.autoRoute,
			'the mid-chat answer stored no Auto choice though the picker was on Auto'
		).toBeTruthy();
		expect(
			stored?.autoRoute?.model,
			'Auto kept the first model, so this turn never switched and the PATCH path went unexercised'
		).not.toBe(firstStored?.autoRoute?.model);

		await openStepByStep(page, second, xrayTimeouts);
		const step = page.locator('li[data-step-id="auto-route"]');
		await expect(step, 'Step by step has no Auto step on a mid-chat Auto turn').toBeVisible({
			timeout: 15_000
		});
		await expect(step).toContainText(/Auto chose \S/);
	}
);

// Auto used to send nearly every production turn to Mistral Large 3, which our account may
// call 30 times a minute, because Medium (2,000 a minute) was barred from Auto. A short everyday
// question now goes to Medium; Large 4 takes a task Auto is sure is large, and Large 3 is picked by
// hand only. All three are family "Mistral" and sit in the picker, so the explanation names
// the model itself, and the pick is read from it.
test(
	'on Auto, a short English question names Mistral Medium, keeping Large 4 for large tasks',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		const composer = await openChat(page, context, baseURL!, 'auto');
		await composer.fill('What is the capital of France? Answer in one sentence.');
		const pill = page.getByRole('button', { name: /^Model: Auto · / }).first();
		await expect(pill, 'Auto never read the English draft').toHaveAccessibleName(
			/^Model: Auto · /,
			{
				timeout: 15_000
			}
		);
		await pill.click();
		await expect(
			page.locator('[data-routing-why]'),
			"Auto's pick for a short English question is not Mistral Medium"
		).toContainText('Mistral Medium', { timeout: 15_000 });
	}
);

// Auto sends a draft it reads as large to Mistral Large 4 and keeps Medium for the rest (the
// test above). routing.spec.ts checks the classifier reads this draft as large; this sends it on a real
// preview and reads both the stored choice and X-ray's Auto step.
const HARD_DRAFT =
	'Compare the tradeoffs between event sourcing and a plain relational schema for an invoicing system with about two million invoices a year. Explain why each choice affects auditing, corrections and reporting, evaluate which one a small team should pick, and design a migration from the relational schema if they later need event sourcing. What breaks first? What would you measure? How would you roll it back?';

test(
	"on Auto, a hard English question is answered by Mistral Large 4, and X-ray's Step by step says Auto chose it",
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const composer = await openChat(page, context, baseURL!, 'auto');
		await composer.fill(HARD_DRAFT);
		const pill = page.getByRole('button', { name: /^Model: Auto · / }).first();
		await expect(pill, 'Auto never read the hard draft').toHaveAccessibleName(/^Model: Auto · /, {
			timeout: 15_000
		});
		await composer.press('Enter');
		const answer = page.locator('[data-message-role="assistant"]').first();
		await expect(
			turnDone(answer),
			'the hard question never finished within 180s' + warmupContext()
		).toBeVisible({
			timeout: 180_000
		});
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const stored = await storedTurn(page, answer);
		test
			.info()
			.annotations.push({ type: 'autoRoute', description: JSON.stringify(stored?.autoRoute) });
		expect(
			stored?.autoRoute?.model,
			'Auto did not choose Large 4 for a question it reads as large'
		).toBe('mistral-large-4');

		await openStepByStep(page, answer, xrayTimeouts);
		await expect(page.locator('li[data-step-id="auto-route"]')).toContainText(/Auto chose \S/, {
			timeout: 15_000
		});
	}
);

test(
	"mid-chat, a turn sent straight after typing, before Auto's draft reading settles, still goes where Auto sends it and stores Auto's choice",
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		const composer = await openChat(page, context, baseURL!, 'auto');
		const first = await ask(
			page,
			composer,
			'¿Cuál es la capital de España? Responde en una frase.'
		);
		const firstStored = await storedTurn(page, first);

		// `ask` fills and presses Enter at once, well inside the 350 ms the composer waits before it
		// reads a draft, so no Auto choice has been published for this text when it sends. The page
		// routes it then, the way the landing page routes a first message.
		const second = await ask(page, composer, CHINESE, 1);
		const stored = await storedTurn(page, second);
		test.info().annotations.push({
			type: 'autoRoute per turn',
			description: JSON.stringify([firstStored?.autoRoute?.model, stored?.autoRoute?.model])
		});
		expect(
			stored?.autoRoute,
			'a mid-chat Auto turn sent before the draft reading settled stored no Auto choice'
		).toBeTruthy();
		expect(
			stored?.autoRoute?.model,
			'the Chinese turn stayed on the first model, so the send went out before Auto chose'
		).not.toBe(firstStored?.autoRoute?.model);

		await openStepByStep(page, second, xrayTimeouts);
		await expect(page.locator('li[data-step-id="auto-route"]')).toContainText(/Auto chose \S/, {
			timeout: 15_000
		});
	}
);

// Auto's Arabic pick rests on Mistral Large's measured Belebele Arabic score, not a hand-set
// estimate for Apertus (0.65 against Large's 0.35 default). The draft is never sent. Before a first
// message the pill names only the language Auto read, so the pick is read where a person sees it:
// the picker's "how we chose" line,
// "<family> · <size>", once the draft has rested.
test(
	'on Auto, an Arabic draft names the model measured best in Arabic, not Apertus on a hand-set estimate',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		const composer = await openChat(page, context, baseURL!, 'auto');
		await composer.fill('اشرح لي الفرق بين الفيروس والبكتيريا');
		const pill = page.getByRole('button', { name: /^Model: Auto · / }).first();
		await expect(pill, 'Auto never read the Arabic draft').toHaveAccessibleName(
			/^Model: Auto · Arabic\b/,
			{
				timeout: 15_000
			}
		);
		await pill.click();
		await expect(
			page.locator('[data-how-we-chose] [data-language-preview]'),
			"Auto's pick for the Arabic draft is not Mistral Large 3"
		).toContainText(/Arabic\s*Mistral · /, { timeout: 15_000 });
	}
);

// Mistral Medium has no Amharic measurement and Belebele scores it 0.441, against Large 3's 0.556 and Apertus's 0.566. Large 3 and Apertus sit within
// Belebele's noise of each other, so either is a right pick; Medium is not. Read the same way as Arabic.
test(
	'on Auto, an Amharic draft names a model measured near the best in Amharic, never Mistral Medium',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		const composer = await openChat(page, context, baseURL!, 'auto');
		await composer.fill('በቫይረስ እና በባክቴሪያ መካከል ያለውን ልዩነት አስረዳኝ');
		const pill = page.getByRole('button', { name: /^Model: Auto · / }).first();
		await expect(pill, 'Auto never read the Amharic draft').toHaveAccessibleName(
			/^Model: Auto · Amharic\b/,
			{
				timeout: 15_000
			}
		);
		await pill.click();
		const preview = page.locator('[data-how-we-chose] [data-language-preview]');
		await expect(
			preview,
			"Auto's pick for the Amharic draft is not Large 3 or Apertus"
		).toContainText(/Amharic\s*(Mistral|Apertus) · /, { timeout: 15_000 });
		// The family alone can't tell Large 3 from Medium, so read the pick's Amharic score off its meter:
		// 0.41 for Large 3, 0.42 for Apertus, 0.25 for Medium, rescaled above Belebele's 0.25 chance.
		const support = page
			.locator('[data-routing-why]')
			.getByRole('meter')
			.filter({ hasText: 'Amharic support' });
		await expect
			.poll(async () => Number(await support.getAttribute('aria-valuenow')), {
				message: "the pick's measured Amharic score is Medium's, not within noise of the best",
				timeout: 15_000
			})
			.toBeGreaterThanOrEqual(0.39);
	}
);

// Mistral Large 4 scores 0.71 raw on Belebele's Amharic, under the 0.75 line where a model counts as
// still learning a language; GLM 5.2's 0.86 is over it. The notice keys on the model that answers, not
// on Auto's best available model, so a visitor who picks Large 4 sees it in the composer and beside the
// sent answer, after a reload too.
test(
	'with Mistral Large 4 picked by hand, an Amharic answer carries the still-learning notice, before sending and after',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const composer = await openChat(page, context, baseURL!, 'auto', CHAT_ENTRY);

		// Picked the way a visitor picks it: the composer's model button, then "Choose a model yourself".
		await page
			.getByRole('button', { name: /^Model: / })
			.first()
			.click({ timeout: 10_000 });
		const row = page.getByRole('menuitemradio', { name: /^Mistral Large 4\b/ });
		const yourself = page.getByRole('menuitem', { name: /^Choose a model yourself/ });
		await expect(row.or(yourself).first()).toBeVisible({ timeout: 10_000 });
		if (await yourself.isVisible()) await yourself.click();
		await row.click({ timeout: 10_000 });
		// With Auto on, a hand-picked model's pill names its family ("Model: Mistral"), which Medium
		// shares, so the exact pick is read from the device's saved choice.
		await expect(
			page.locator('[data-model-pill]').first(),
			'the pill still reads Auto after picking Large 4 by hand'
		).toHaveAttribute('aria-label', /^Model: Mistral\b/, { timeout: 10_000 });
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), CHOICE_KEY), {
				message: 'the device did not save Large 4 as its pick',
				timeout: 10_000
			})
			.toBe('mistral-large-4');

		const question = 'የኢትዮጵያ ዋና ከተማ ማን ናት? በአንድ ዓረፍተ ነገር መልስ።';
		await composer.fill(question);
		await expect(
			page.getByRole('button', { name: /^Amharic: Alpha is still learning it\b/ }),
			'the composer shows no still-learning pill for an Amharic draft going to Large 4'
		).toBeVisible({ timeout: 15_000 });

		const answer = await ask(page, composer, question);
		const note = answer.locator('[data-still-learning="amh"]');
		await expect(
			note,
			'the sent Amharic answer from Large 4 carries no still-learning notice'
		).toBeVisible({
			timeout: 15_000
		});
		const stored = await storedTurn(page, answer);
		expect(
			stored?.autoRoute,
			'a hand-picked Large 4 was recorded as chosen by Auto'
		).toBeUndefined();

		await page.reload({ waitUntil: 'commit' });
		await expect(
			page
				.locator('[data-message-role="assistant"]')
				.first()
				.locator('[data-still-learning="amh"]'),
			'the still-learning notice is gone after a reload'
		).toBeVisible({ timeout: 30_000 });
	}
);

// Polish follows the scores: Mistral Medium 3.5 carries its Artificial Analysis rating of 14
// against Bielik's hand-set 3, so Auto sends a short Polish draft to Medium, and Bielik is for picking by
// hand. The family alone can't tell Medium from Large 4, so read the pick's Intelligence meter: 14 is
// Medium 3.5's rating, 38 Large 4's, 3 Bielik's. Read the same way as Arabic; the draft is never sent.
test(
	'on Auto, a short Polish draft names Mistral Medium 3.5, rated 14, not Bielik',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		const composer = await openChat(page, context, baseURL!, 'auto');
		await composer.fill('Czy możesz mi pomóc z tym? Nie jest to łatwe.');
		const pill = page.getByRole('button', { name: /^Model: Auto · / }).first();
		await expect(pill, 'Auto never read the Polish draft').toHaveAccessibleName(
			/^Model: Auto · Polish\b/,
			{
				timeout: 15_000
			}
		);
		await pill.click();
		await expect(
			page.locator('[data-how-we-chose] [data-language-preview]'),
			"Auto's pick for the Polish draft is not Mistral"
		).toContainText(/Polski\s*Mistral · |Polish\s*Mistral · /, { timeout: 15_000 });
		const intelligence = page
			.locator('[data-routing-why]')
			.getByRole('meter')
			.filter({ hasText: 'Intelligence' });
		await expect
			.poll(async () => Number(await intelligence.getAttribute('aria-valuenow')), {
				message: "the Polish pick's intelligence rating is not Medium 3.5's 14",
				timeout: 15_000
			})
			.toBe(14);
	}
);

// X-ray's stack read the roadmap's statuses as claims about Alpha: "built from 19 open parts"
// though hosting on La Plateforme is not open, "Public computers: Working" though no model the picker
// offers runs on them, and "Model chooser: Being built" though Auto chooses the model.
test(
	'X-ray\'s stack claims no "open parts", says public computers are not in use, and lights the model chooser on an Auto answer',
	{ tag: ['@F2'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		const composer = await openChat(page, context, baseURL!, 'auto');

		await page.getByRole('button', { name: 'X-ray — see what happened behind the answer' }).click();
		const stack = page.locator('[data-xray-panel] [data-xray-stack-only]');
		const summary = stack.locator('[data-stack-summary]');
		await expect(summary).toContainText(/built from \d+ parts/, { timeout: 15_000 });
		await expect(summary, 'the count still calls every part open').not.toContainText('open parts');
		const compute = stack.locator('li[data-product-id="sovereign-compute"]');
		await expect(compute).toContainText('Not in use right now');
		await expect(compute).not.toContainText('Working');
		const chooser = stack.locator('li[data-product-id="model-router"]');
		await expect(chooser, 'Auto is on and the model chooser reads as unbuilt').toContainText(
			'Working'
		);

		const answer = await ask(page, composer, 'What is the capital of Spain? One sentence.');
		const stored = await storedTurn(page, answer);
		expect(
			stored?.autoRoute,
			'the answer stored no Auto choice though the picker was on Auto'
		).toBeTruthy();

		await openXrayTab(page, answer, 'The stack', xrayTimeouts);
		const answered = page.locator('[data-xray-panel] li[data-product-id="model-router"]');
		await expect(answered, 'Auto chose the model and the chooser is not lit').toHaveAttribute(
			'data-used',
			'true',
			{ timeout: 15_000 }
		);
		await expect(answered).toContainText('Used for this answer');
		await expect(
			page.locator('[data-xray-panel] li[data-product-id="sovereign-compute"]')
		).not.toContainText('Working');
	}
);
