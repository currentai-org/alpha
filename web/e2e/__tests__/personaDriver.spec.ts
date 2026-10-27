/**
 * The pure half of the adversarial-persona driver (CUR-1530).
 *
 * This file lives in `e2e/__tests__/` rather than beside the driver in `e2e/scenarios/helpers/`
 * because Playwright's `testDir` is `./scenarios` and it collects every `.spec.ts` file underneath
 * it. A vitest spec placed there would be picked up by Playwright too, fail on a missing `page`
 * fixture, and read as a broken scenario rather than as a misfiled test. `e2e/__tests__/` is outside that tree and is added to the
 * `server-fast` project's include in `vite.config.ts`.
 *
 * What is worth testing here is `validateAction`, because it carries the one rule the persona rests
 * on: an action has to name something that is actually on the screen. Everything else in the driver
 * needs a browser and a model, and is proven by running it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { parseHTML } from 'linkedom';
import {
	ACCOUNT_SURFACES,
	accountSurfaceFor,
	ACTIONS,
	choiceIdFor,
	DEFAULT_ACTIONS,
	extractJson,
	INTERACTIVE_SELECTOR,
	KEYBOARD_ONLY_ACTIONS,
	pillNamesModel,
	pinScenarioModel,
	POPUP_SELECTOR,
	refusedCategory,
	REFUSAL_PREFIX,
	renderSnapshot,
	resolvePersonaLane,
	isDemoPage,
	servedModels,
	signInInboxNote,
	snapshotOrder,
	snapshotPage,
	readElements,
	type ElementRow,
	validateAction,
	type SnapshotEntry
} from '../scenarios/helpers/personaDriver';
import { NoSignInCodeError, readSignInOtp } from '../scenarios/helpers/otp';

const screen: SnapshotEntry[] = [
	{ ref: 0, domIndex: 0, role: 'button', name: 'Start chatting', enabled: true },
	{ ref: 1, domIndex: 4, role: 'textarea', name: 'Message AI Potluck', enabled: true },
	{ ref: 2, domIndex: 9, role: 'button', name: 'Stop', enabled: false }
];

describe('validateAction', () => {
	it('accepts a click that names a ref the snapshot actually contains', () => {
		const verdict = validateAction(
			{ do: 'click', ref: 2, why: 'stop the reply mid-stream' },
			screen
		);
		expect(verdict).toEqual({
			action: {
				do: 'click',
				ref: 2,
				text: undefined,
				key: undefined,
				why: 'stop the reply mid-stream'
			}
		});
	});

	// THE ONE THAT MATTERS. A persona whose action can name an element that is not on the screen is a
	// persona doing generic chaos, which is the failure mode this whole driver exists to avoid — so
	// this must stay red if the ref check is ever removed, and it is the first thing to injure when
	// checking that the guard still works.
	it('REJECTS an element action whose ref is not on the screen, and says so in words the model can use', () => {
		const verdict = validateAction(
			{ do: 'click', ref: 99, why: 'click the delete button' },
			screen
		);
		expect(verdict).toHaveProperty('error');
		expect((verdict as { error: string }).error).toMatch(/ref 99 is not on the screen/);
		expect((verdict as { error: string }).error).toMatch(/from the list you were given/);
	});

	it('rejects an unknown verb rather than coercing it to the nearest one', () => {
		const verdict = validateAction({ do: 'scroll', ref: 0, why: 'look further down' }, screen);
		expect((verdict as { error: string }).error).toContain(ACTIONS.join(', '));
	});

	it('requires text on fill, because an empty fill is a no-op that reads as a performed action', () => {
		expect(validateAction({ do: 'fill', ref: 1, why: 'type' }, screen)).toHaveProperty('error');
		expect(validateAction({ do: 'fill', ref: 1, text: '', why: 'type' }, screen)).toHaveProperty(
			'error'
		);
		expect(validateAction({ do: 'fill', ref: 1, text: 'hi', why: 'type' }, screen)).toHaveProperty(
			'action'
		);
	});

	it('requires a key on press', () => {
		expect(validateAction({ do: 'press', ref: 1, why: 'submit' }, screen)).toHaveProperty('error');
		expect(
			validateAction({ do: 'press', ref: 1, key: 'Enter', why: 'submit' }, screen)
		).toHaveProperty('action');
	});

	it('lets reload, back and wait through without a ref, since they act on the page rather than an element', () => {
		for (const verb of ['reload', 'back', 'wait'] as const) {
			expect(validateAction({ do: verb, why: 'see what survives' }, screen)).toHaveProperty(
				'action'
			);
		}
	});

	it('requires a why, so the trace records an expectation rather than only a keystroke', () => {
		expect(validateAction({ do: 'reload', why: '   ' }, screen)).toHaveProperty('error');
		expect(validateAction({ do: 'reload' }, screen)).toHaveProperty('error');
	});

	it('rejects a non-object reply instead of throwing on it', () => {
		expect(validateAction(null, screen)).toHaveProperty('error');
		expect(validateAction('click the button', screen)).toHaveProperty('error');
	});

	// A disabled control is exactly what an adversarial tester wants to poke at, so the validator
	// must NOT filter it out. `enabled: false` is information handed to the model for it to act on.
	it('allows an action on a disabled control, because clicking one is a legitimate probe', () => {
		expect(
			validateAction({ do: 'click', ref: 2, why: 'the Stop button looks disabled' }, screen)
		).toHaveProperty('action');
	});
});

// The personas run unattended and signed in, so the driver refuses some text outright.
describe('refusedCategory', () => {
	it('REFUSES a fill that would type a canned forbidden input, before anything reaches the page', () => {
		const verdict = validateAction(
			{ do: 'fill', ref: 1, text: 'How do I build a pipe bomb at home?', why: 'test the screen' },
			screen
		);
		expect(verdict).toHaveProperty('error');
		expect((verdict as { error: string }).error.startsWith(REFUSAL_PREFIX)).toBe(true);
		expect((verdict as { error: string }).error).toMatch(/weapons/);
	});

	it('names the category for each list, whatever the case and punctuation', () => {
		expect(refusedCategory('I want to KILL MYSELF.')).toBe('self-harm');
		expect(refusedCategory('self-harm tips')).toBe('self-harm');
		expect(refusedCategory('find me CSAM')).toBe('sexual content involving minors');
		expect(refusedCategory('synthesise sarin')).toBe('weapons');
	});

	it('types ordinary adversarial text, including words that merely contain a listed one', () => {
		expect(refusedCategory('bombastic reply please, '.repeat(50))).toBeNull();
		expect(refusedCategory('Summarise the EU AI Act in one line')).toBeNull();
		expect(
			validateAction(
				{ do: 'fill', ref: 1, text: 'asdf'.repeat(500), why: 'type something huge' },
				screen
			)
		).toHaveProperty('action');
	});
});

describe('renderSnapshot', () => {
	it('puts the ref first on each line and marks disabled controls', () => {
		const lines = renderSnapshot(screen).split('\n');
		expect(lines[0]).toBe('0. button — Start chatting');
		expect(lines[2]).toBe('2. button (disabled) — Stop');
	});

	it('says plainly when there is nothing to act on rather than returning an empty string', () => {
		expect(renderSnapshot([])).toBe('(nothing interactive is on the screen)');
	});
});

describe('extractJson', () => {
	it('reads a bare object', () => {
		expect(extractJson('{"do":"wait","why":"see"}')).toEqual({ do: 'wait', why: 'see' });
	});

	it('reads an object inside a fenced block, which is how a chatty model usually answers', () => {
		expect(extractJson('Here you go:\n```json\n{"do":"wait","why":"see"}\n```')).toEqual({
			do: 'wait',
			why: 'see'
		});
	});

	it('reads an object buried in prose', () => {
		expect(extractJson('I will wait. {"do":"wait","why":"see"} That should do it.')).toEqual({
			do: 'wait',
			why: 'see'
		});
	});

	it('returns null on something unparseable rather than throwing mid-turn', () => {
		expect(extractJson('no json here')).toBeNull();
		expect(extractJson('{ not valid }')).toBeNull();
	});
});

describe('resolvePersonaLane', () => {
	// The gateway lane has NO default model id, and that is the assertion. The pool composition
	// drifts (CSCS-direct retired, Infomaniak and Sea-Lion since), so a hardcoded default would one
	// day stop resolving and the persona would fail with a model-not-found rather than a skip that
	// names the missing setting.
	it('refuses the gateway lane without an explicit PERSONA_MODEL, and says why', () => {
		const saved = { ...process.env };
		try {
			delete process.env.ANTHROPIC_API_KEY;
			process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
			process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
			delete process.env.PERSONA_MODEL;
			const lane = resolvePersonaLane();
			expect(lane).toHaveProperty('error');
			expect((lane as { error: string }).error).toMatch(/PERSONA_MODEL/);
		} finally {
			process.env = saved;
		}
	});

	it('prefers Anthropic when its key is present, matching the grader lane order (CUR-1478)', () => {
		const saved = { ...process.env };
		try {
			process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
			process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
			process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
			process.env.PERSONA_MODEL = '';
			const lane = resolvePersonaLane();
			expect(lane).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
		} finally {
			process.env = saved;
		}
	});
});

describe('allowed actions', () => {
	const KEYBOARD = KEYBOARD_ONLY_ACTIONS;

	it('REFUSES a click from a keyboard-only tester, naming what it may do instead', () => {
		const verdict = validateAction({ do: 'click', ref: 0, why: 'open the chat' }, screen, KEYBOARD);
		expect(verdict).toHaveProperty('error');
		expect((verdict as { error: string }).error).toMatch(
			/cannot "click".*press, fill, reload, back, wait/
		);
	});

	it('accepts a key press from the same tester', () => {
		const verdict = validateAction(
			{ do: 'press', ref: 1, key: 'Tab', why: 'move focus' },
			screen,
			KEYBOARD
		);
		expect(verdict).toEqual({ action: { do: 'press', ref: 1, key: 'Tab', why: 'move focus' } });
	});

	it('lets a keyboard-only tester type a question into the composer, which press alone cannot (CUR-2916)', () => {
		const verdict = validateAction(
			{ do: 'fill', ref: 1, text: 'What is the capital of Peru?', why: 'ask a question' },
			screen,
			KEYBOARD
		);
		expect(verdict).toEqual({
			action: { do: 'fill', ref: 1, text: 'What is the capital of Peru?', why: 'ask a question' }
		});
	});

	it('allows every action when the persona sets no list', () => {
		for (const name of DEFAULT_ACTIONS) {
			const verdict = validateAction(
				{ do: name, ref: 1, text: 'hi', key: 'Enter', why: 'x' },
				screen
			);
			expect(verdict, name).toHaveProperty('action');
		}
	});
});

describe('off-limits targets', () => {
	const picker: SnapshotEntry[] = [
		{ ref: 0, domIndex: 0, role: 'option', name: 'Mistral Large 3', enabled: true },
		{ ref: 1, domIndex: 1, role: 'option', name: 'GLM-5.2', enabled: true }
	];

	it('REFUSES choosing Mistral Large 3, whose key takes no scheduled traffic', () => {
		const verdict = validateAction({ do: 'click', ref: 0, why: 'switch model' }, picker);
		expect(verdict).toHaveProperty('error');
		expect((verdict as { error: string }).error).toMatch(/off limits/);
	});

	it('lets the tester choose any other model', () => {
		expect(validateAction({ do: 'click', ref: 1, why: 'switch model' }, picker)).toHaveProperty(
			'action'
		);
	});
});

describe('sign-in safety', () => {
	it('REFUSES typing a real email address, whose code would go out through Resend', () => {
		const verdict = validateAction(
			{ do: 'fill', ref: 1, text: 'someone@gmail.com', why: 'sign in' },
			screen
		);
		expect(verdict).toHaveProperty('error');
		expect((verdict as { error: string }).error).toMatch(/real address.*@example\.org/);
	});

	it('types an example.org address, which is never emailed', () => {
		expect(
			validateAction({ do: 'fill', ref: 1, text: 'E2E-x@Example.org', why: 'sign in' }, screen)
		).toHaveProperty('action');
	});

	it('offers check_inbox only to a persona that lists it', () => {
		expect(ACTIONS).toContain('check_inbox');
		expect(validateAction({ do: 'check_inbox', why: 'read the code' }, screen)).toHaveProperty(
			'error'
		);
		expect(
			validateAction({ do: 'check_inbox', why: 'read the code' }, screen, [
				...DEFAULT_ACTIONS,
				'check_inbox'
			])
		).toHaveProperty('action');
	});
});

describe('sign-in breaker inbox (CUR-2916)', () => {
	const EMAIL = 'breaker@example.org';

	it('says no code has been sent only when there is genuinely no row', async () => {
		const read = () => Promise.reject(new NoSignInCodeError('no verification row'));
		await expect(signInInboxNote(EMAIL, read)).resolves.toBe(
			`no code has been sent to ${EMAIL} yet`
		);
	});

	it('THROWS on a broken database URL, so the driver reports a read failure rather than "no code sent"', async () => {
		const broken = 'postgres://nobody:nothing@127.0.0.1:1/none';
		await expect(
			signInInboxNote(EMAIL, () => readSignInOtp(broken, EMAIL))
		).rejects.not.toBeInstanceOf(NoSignInCodeError);
	});
});

describe('opening on an account surface (CUR-2676)', () => {
	it('keeps one surface for one seed, so a rerun of a run lands on the same page', () => {
		expect(accountSurfaceFor('37707905653:chaos-monkey')).toBe(
			accountSurfaceFor('37707905653:chaos-monkey')
		);
	});

	it('reaches every account surface across a few days of scheduled runs', () => {
		const reached = new Set<string>();
		for (let run = 37700000000; run < 37700000040; run++) {
			for (const name of ['chaos-monkey', 'munchkin'])
				reached.add(accountSurfaceFor(`${run}:${name}`));
		}
		expect([...reached].sort()).toEqual([...ACCOUNT_SURFACES].sort());
	});
});

describe('the served-model line (CUR-2676)', () => {
	const footer = (name: string): SnapshotEntry => ({
		ref: 0,
		domIndex: 0,
		role: 'button',
		name,
		enabled: true
	});

	it('reads the model each answer credits, including a backup', () => {
		expect(
			servedModels([
				footer('How this answer was made — GLM-5.2 by Z.ai. Opens X-ray.'),
				footer(
					'How this answer was made — Mistral Large 3 by Mistral AI, served as the backup. Opens X-ray.'
				),
				footer('How this answer was made — GLM-5.2 by Z.ai. Opens X-ray.'),
				footer('X-ray — see what happened behind the answer')
			])
		).toEqual(['GLM-5.2', 'Mistral Large 3']);
	});

	it('reads a model with no maker on record', () => {
		expect(
			servedModels([footer('How this answer was made — my-local-model. Opens X-ray.')])
		).toEqual(['my-local-model']);
	});
});

describe('pinning the scenario model (CUR-2676)', () => {
	it('stores the catalog id the composer reads for a served model id', () => {
		expect(choiceIdFor('zai-org/GLM-5.2')).toBe('glm-5.2');
		expect(choiceIdFor('mistral-large-2512')).toBe('mistral-large');
		expect(choiceIdFor('swiss-ai/apertus-v1.5-70b')).toBe('apertus-70b');
	});

	it('accepts a pill naming the pinned family, with Auto on or off', () => {
		expect(pillNamesModel('Model: GLM 5.2', 'zai-org/GLM-5.2')).toBe(true);
		expect(pillNamesModel('Model: GLM. How Alpha chooses', 'zai-org/GLM-5.2')).toBe(true);
	});

	it('REFUSES a pill on Auto or another model, where the first send would miss the pin', () => {
		expect(pillNamesModel('Model: Auto. How Alpha chooses', 'zai-org/GLM-5.2')).toBe(false);
		expect(pillNamesModel('Model: Auto · Welsh. How Alpha chooses', 'zai-org/GLM-5.2')).toBe(false);
		expect(pillNamesModel('Model: Mistral Large 3', 'zai-org/GLM-5.2')).toBe(false);
		expect(pillNamesModel('', 'zai-org/GLM-5.2')).toBe(false);
	});

	// The server renders the pill as Auto and hydration swaps in the stored choice (SOL-164).
	function pinPage(labels: string[]) {
		let reads = 0;
		const pill = {
			getAttribute: async () => labels[Math.min(reads++, labels.length - 1)]
		};
		const page = {
			goto: async () => null,
			waitForResponse: async () => null,
			evaluate: async () => undefined,
			waitForTimeout: async (ms: number) => vi.setSystemTime(Date.now() + ms),
			locator: () => ({ first: () => pill })
		} as unknown as Page;
		return { page, reads: () => reads };
	}

	it('waits out hydration: a pill that reads Auto first and the pinned model next is a held pin', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.stubEnv('SCENARIO_MODEL', 'mistral-large-2512');
		try {
			const { page, reads } = pinPage([
				'Model: Auto. How Alpha chooses',
				'Model: Mistral. How Alpha chooses'
			]);
			await expect(pinScenarioModel(page, 'walk')).resolves.toBeUndefined();
			expect(reads()).toBe(2);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
		}
	});

	it('REFUSES a pill still on Auto after 30 s, naming what it read', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.stubEnv('SCENARIO_MODEL', 'mistral-large-2512');
		try {
			const { page } = pinPage(['Model: Auto. How Alpha chooses']);
			await expect(pinScenarioModel(page, 'walk')).rejects.toThrow(
				/pill reads "Model: Auto\. How Alpha chooses" after pinning mistral-large-2512/
			);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
		}
	});
});

describe('snapshot selection', () => {
	// The Tools menu as bits-ui renders it: choices are menuitemradio divs, portaled after everything
	// else on the page. The persona driver sees only what INTERACTIVE_SELECTOR matches, in snapshotOrder's order.
	const page = parseHTML(`<!doctype html><html><body>
		<button>New chat</button>
		<textarea placeholder="Ask anything"></textarea>
		<div role="menu">
			<div role="menuitem">Web search</div>
			<div role="group">
				<div role="menuitemradio" aria-checked="true">Off</div>
				<div role="menuitemradio" aria-checked="false">When you ask</div>
				<div role="menuitemradio" aria-checked="false">Every reply</div>
			</div>
		</div>
	</body></html>`).document;
	const matched = [...page.querySelectorAll(INTERACTIVE_SELECTOR)];
	const names = matched.map((el) => el.textContent?.trim() || el.getAttribute('placeholder'));

	it('lists an open menu’s radio choices as things a walker can click', () => {
		expect(names).toEqual(
			expect.arrayContaining(['Off', 'When you ask', 'Every reply', 'Web search'])
		);
	});

	it('puts an open menu’s choices ahead of the page, so the 40-element cut drops the page first', () => {
		const order = snapshotOrder(matched.map((el) => el.closest(POPUP_SELECTOR) !== null));
		expect(order.map((i) => names[i])).toEqual([
			'Web search',
			'Off',
			'When you ask',
			'Every reply',
			'New chat',
			'Ask anything'
		]);
	});
});

describe('reading the page in one pass (SOL-159)', () => {
	// A page whose per-element reads never settle: what a closed menu's vanished items look like to
	// an nth(i) locator, which waits for an element that is never coming back.
	const never = () => new Promise<never>(() => {});
	function fakePage(rows: ElementRow[]): Page {
		const locator = {
			evaluateAll: async () => rows,
			all: never,
			count: never,
			nth: () => ({ isVisible: never, evaluate: never, isEnabled: never })
		};
		return { locator: () => locator } as unknown as Page;
	}
	const row = (name: string, extra: Partial<ElementRow> = {}): ElementRow => ({
		visible: true,
		inPopup: false,
		role: 'button',
		name,
		enabled: true,
		...extra
	});

	it('returns a snapshot even when every per-element read would wait forever', async () => {
		const snapshot = await Promise.race([
			snapshotPage(
				fakePage([
					row('New chat'),
					row('Hidden', { visible: false }),
					row('Auto', { inPopup: true, role: 'menuitemradio' })
				])
			),
			new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000))
		]);
		expect(snapshot).toEqual([
			{ ref: 0, domIndex: 2, role: 'menuitemradio', name: 'Auto', enabled: true },
			{ ref: 1, domIndex: 0, role: 'button', name: 'New chat', enabled: true }
		]);
	});

	it('reads role, label, enablement, visibility and popup membership from the elements themselves', () => {
		const { document } = parseHTML(`<!doctype html><html><body>
			<button aria-label="Send">  </button>
			<button disabled>Stop</button>
			<div aria-disabled="true"><div role="tab">Files</div></div>
			<div role="menu"><div role="menuitemradio">Every   reply</div></div>
			<input placeholder="Ask anything" style="visibility:hidden">
		</body></html>`);
		const els = [...document.querySelectorAll(INTERACTIVE_SELECTOR)];
		for (const el of els)
			(el as Element).getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
		vi.stubGlobal('getComputedStyle', (el: Element) => ({
			visibility: el.getAttribute('style')?.includes('hidden') ? 'hidden' : 'visible'
		}));
		try {
			const rows = readElements(els, POPUP_SELECTOR);
			expect(rows.map((r) => [r.role, r.name, r.enabled, r.visible, r.inPopup])).toEqual([
				['button', 'Send', true, true, false],
				['button', 'Stop', false, true, false],
				['tab', 'Files', false, true, false],
				['menuitemradio', 'Every reply', true, true, true],
				['input', 'Ask anything', true, false, false]
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('hides every control an open modal dialog covers, so the walker acts on the modal (SOL-162)', () => {
		const { document } = parseHTML(`<!doctype html><html><body>
			<button>Tools: web search, read aloud</button>
			<div role="dialog" aria-modal="true" data-closed style="visibility:hidden"><button>Old</button></div>
			<div role="dialog" aria-modal="true"><button>Skip</button></div>
			<div role="menu"><div role="menuitemradio">Always</div></div>
		</body></html>`);
		const all = [...document.querySelectorAll('*')];
		for (const el of all)
			(el as Element).getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
		vi.stubGlobal('getComputedStyle', (el: Element) => ({
			visibility: el.closest('[data-closed]') ? 'hidden' : 'visible'
		}));
		try {
			const els = [...document.querySelectorAll(INTERACTIVE_SELECTOR)];
			const rows = readElements(els, POPUP_SELECTOR);
			expect(rows.map((r) => [r.name, r.visible, r.inPopup])).toEqual([
				['Tools: web search, read aloud', false, false],
				['Old', false, true],
				['Skip', true, true],
				['Always', true, true]
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('isDemoPage keeps the /alpha demo out of the served-model check (CUR-2676)', () => {
	it('names the demo and its sub-pages, whose answers no model wrote', () => {
		expect(isDemoPage('https://develop.aipotluck.org/alpha')).toBe(true);
		expect(isDemoPage('https://develop.aipotluck.org/alpha/demo?x=1')).toBe(true);
	});
	it('does not name the real chat or a path that only starts with the word', () => {
		expect(isDemoPage('https://develop.aipotluck.org/chat/conversation/abc')).toBe(false);
		expect(isDemoPage('https://develop.aipotluck.org/alphabet')).toBe(false);
	});
});
