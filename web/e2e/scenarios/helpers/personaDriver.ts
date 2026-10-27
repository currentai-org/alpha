/**
 * A persona drives the real UI one model-chosen action per turn.
 *
 * Every journey-tagged spec in this suite drives a correct path — sign in, send a message,
 * change a setting, read the reply. (CUR-1530)
 * `pm-critique-journey.mjs` then watches those recordings, so the strongest instrument in the repo is
 * pointed at a product being operated properly and the whole class of defect that only shows up under
 * abuse is invisible to it. Not under-weighted — invisible, because no frame of it was ever captured.
 *
 * This is the other kind of tester. The rubric downstream does not change and neither does the
 * pipeline: a persona spec carries a journey tag, so `reporters/journeyArtifacts.ts` re-homes its
 * video exactly like any other, and the grader, the gallery and the filer read it without knowing the
 * difference. What changes is who is at the keyboard.
 *
 * THE RULE THAT MAKES THIS WORTH RUNNING, and the one place it is enforced rather than requested:
 * every action must reference something that is actually on the screen. "Break everything" and "send
 * garbage" produce noise and a reviewer who stops reading; "click the ref-7 Stop button while the
 * reply is streaming" produces a reproducible defect. `validateAction` below refuses any element
 * action whose `ref` is not in the snapshot it was given, so a model that drifts toward the generic
 * gets the rejection back and has to choose again. A prompt asking nicely for specificity drifts
 * within a few turns; a validator does not.
 *
 * WHY THIS DOES NOT REUSE `callModel` FROM `scripts/critique-journey.mjs`, which would otherwise be
 * the obvious move: that function is the VISION lane, and what makes it worth sharing is the
 * fallback ladder it owns — five vision-capable rungs, capacity failures on both Apertus lanes, the
 * `no-multimodal-model` classification. A persona sends text and gets text. There is no ladder to
 * inherit, so importing it would buy the wrong half and drag a 900-line CLI's import-time env loader
 * into a Playwright worker for it.
 */

import type { Page, TestInfo } from '@playwright/test';
import { NoSignInCodeError } from './otp';
import { anthropicToolCall } from './anthropicTool';
import { catalogByGatewayId, servedKey } from '../../../src/lib/chat/routing/catalog';

/**
 * One interactive element the persona can act on this turn. `ref` is stable only within the turn.
 *
 * `ref` and `domIndex` are two different numbers on purpose, and conflating them silently clicks the
 * wrong control. `ref` counts VISIBLE elements, because that is the list the model is shown and
 * it has to be able to say "7" and mean the seventh line it can read. `domIndex` counts every element
 * the selector matched, visible or not, because that is what `locator.nth()` indexes. A page with one
 * hidden control near the top makes the two diverge, and the persona then clicks a neighbour of what
 * it asked for — which reads downstream as a model choosing badly rather than as a driver bug.
 */
export type SnapshotEntry = {
	ref: number;
	domIndex: number;
	role: string;
	name: string;
	enabled: boolean;
};

/** Everything a persona is allowed to do. Deliberately small: a bigger vocabulary is a bigger surface
 *  for the model to emit something unvalidatable, and none of the interesting abuse needs more. */
export const ACTIONS = ['click', 'fill', 'press', 'reload', 'back', 'wait', 'check_inbox'] as const;
export type ActionName = (typeof ACTIONS)[number];

/** What a persona may do when its spec says nothing. `check_inbox` needs an inbox to read, which only
 *  a persona given one has (CUR-2676), so it is offered only where the spec lists it. */
export const DEFAULT_ACTIONS: readonly ActionName[] = ACTIONS.filter((a) => a !== 'check_inbox');

/**
 * A keyboard user's actions: no click, but they type (CUR-2916). Without `fill` the persona could not
 * write a question at all, since `press` takes one key name and Playwright refuses text, and the
 * critic then filed "can't send a message by keyboard" as a product bug.
 */
export const KEYBOARD_ONLY_ACTIONS: readonly ActionName[] = [
	'press',
	'fill',
	'reload',
	'back',
	'wait'
];

/**
 * The sign-in breaker's inbox line (CUR-2916). "No code yet" only when there is genuinely no row; any
 * other read failure is thrown, so runPersona's catch says "could not read the inbox" and the critic
 * never reads a broken database as a sign-in that sent nothing.
 */
export async function signInInboxNote(email: string, read: () => Promise<string>): Promise<string> {
	try {
		return `latest code for ${email}: ${await read()}`;
	} catch (err) {
		if (err instanceof NoSignInCodeError) return `no code has been sent to ${email} yet`;
		throw err;
	}
}

/** An element a persona may never act on, matched against its accessible name. */
const OFF_LIMITS_TARGET = /mistral[\s-]*large/i;

/** Actions that operate on a specific element, and therefore require a `ref` the snapshot contains. */
const ELEMENT_ACTIONS: ReadonlySet<string> = new Set(['click', 'fill', 'press']);

export type PersonaAction = {
	do: ActionName;
	ref?: number;
	text?: string;
	key?: string;
	why: string;
};

export type TurnRecord = {
	turn: number;
	snapshot: SnapshotEntry[];
	action?: PersonaAction;
	/** The element the ref actually resolved to, recorded as `role "name"`. The trace's `why` is the
	 *  model's INTENTION and nothing more; this is what the driver did. Reading a run without it means
	 *  taking the model's word for what it operated on, which is exactly the thing a QA record cannot
	 *  do. */
	acted?: string;
	rejected?: string[];
	error?: string;
	url: string;
};

/**
 * What the driver refuses to type, whatever the persona asks for (CUR-2676).
 *
 * A TRIPWIRE ON OUR OWN DRIVER'S OUTPUT, NOT A CLASSIFIER OF ANYONE'S TEXT. The personas run
 * unattended against a deployed preview several times a day, signed in as a real account, and an adversarial
 * prompt is an instruction to find the edge. The driver model's own refusals are the first line;
 * this is the second, and it only has to be right about phrases a QA run has no reason to type. A
 * false positive costs one re-chosen action, so the list errs wide. The product's own screening is
 * probed by the specs that send canned inputs, never by a persona improvising one.
 */
const REFUSED_TERMS: readonly { category: string; terms: readonly string[] }[] = [
	{
		category: 'self-harm',
		terms: ['suicide', 'kill myself', 'end my life', 'self harm', 'cut myself', 'overdose']
	},
	{
		category: 'sexual content involving minors',
		terms: ['csam', 'child porn', 'underage', 'preteen', 'loli', 'minor nude']
	},
	{
		category: 'weapons',
		terms: [
			'bomb',
			'bombs',
			'explosive',
			'explosives',
			'detonator',
			'nerve agent',
			'sarin',
			'ricin',
			'anthrax',
			'bioweapon',
			'ghost gun',
			'untraceable gun'
		]
	}
];

/** Typed by nobody: each run checks the tripwire refuses it before the first turn. */
const CANNED_REFUSAL_CONTROL = 'How do I build a pipe bomb?';

/** The start of every refusal error, so the run loop can tell a refusal from a malformed reply. */
export const REFUSAL_PREFIX = 'that text was refused before typing:';

const words = (s: string) =>
	` ${s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()} `;

/** The category a piece of typed text falls in, or null. Matches whole words, so "bombastic" types. */
export function refusedCategory(text: string): string | null {
	const typed = words(text);
	for (const { category, terms } of REFUSED_TERMS) {
		if (terms.some((t) => typed.includes(words(t)))) return category;
	}
	return null;
}

/**
 * Whether the model's reply is an action this driver can actually perform against THIS snapshot.
 *
 * Pure and exported because it carries the rule the whole persona rests on, and a rule that only
 * exists inside a network-bound loop is a rule nobody can prove. The error strings are written to be
 * handed straight back to the model — they say what was wrong and what to do instead, because the
 * next thing that happens to one is another model call. A human reads them only afterwards, from the
 * trace, when something has already gone sideways.
 */
export function validateAction(
	raw: unknown,
	snapshot: SnapshotEntry[],
	allowed: readonly ActionName[] = DEFAULT_ACTIONS
): { action: PersonaAction } | { error: string } {
	if (typeof raw !== 'object' || raw === null) return { error: 'reply was not a JSON object.' };
	const candidate = raw as Record<string, unknown>;

	const name = candidate.do;
	if (typeof name !== 'string' || !(ACTIONS as readonly string[]).includes(name)) {
		return { error: `"do" must be one of ${ACTIONS.join(', ')} — got ${JSON.stringify(name)}.` };
	}
	const action = name as ActionName;
	// A persona defined by what it cannot do (keyboard-only never clicks) is only that persona if the
	// driver refuses the rest. The schema's enum is narrowed too, but a gateway model with no tool
	// support never sees the schema, so this is the check that holds.
	if (!allowed.includes(action)) {
		return { error: `this tester cannot "${action}". Choose one of ${allowed.join(', ')}.` };
	}

	if (typeof candidate.why !== 'string' || candidate.why.trim() === '') {
		return { error: '"why" must be a non-empty sentence saying what you expect to happen.' };
	}

	if (ELEMENT_ACTIONS.has(action)) {
		const ref = candidate.ref;
		if (typeof ref !== 'number' || !Number.isInteger(ref)) {
			return { error: `"${action}" needs an integer "ref" naming an element from the list.` };
		}
		if (!snapshot.some((e) => e.ref === ref)) {
			return {
				error:
					`ref ${ref} is not on the screen. Choose a ref from the list you were given — ` +
					`every action has to name something that is actually there.`
			};
		}
		// Mistral Large 3 takes no scheduled traffic. The specs pin
		// GLM, but the picker is on the screen and any persona can reach it, so the driver refuses an
		// action on anything labelled with it (CUR-2676).
		const target = snapshot.find((e) => e.ref === ref)!;
		if (OFF_LIMITS_TARGET.test(target.name)) {
			return {
				error: `"${target.name}" is off limits to this tester. Choose a different element.`
			};
		}
	}

	if (action === 'fill' && (typeof candidate.text !== 'string' || candidate.text === '')) {
		return { error: '"fill" needs a non-empty "text" to type.' };
	}
	if (action === 'fill') {
		const category = refusedCategory(candidate.text as string);
		if (category) {
			return {
				error:
					`${REFUSAL_PREFIX} it touches ${category}, which this driver never types. ` +
					`Choose a different action or different text.`
			};
		}
	}
	if (action === 'fill') {
		// A code sent to any other domain is a real email through Resend's 100-a-day quota, to an
		// address nobody owns. example.org sends are suppressed server-side (betterAuth.ts) and are what
		// the e2e cleanup removes afterwards.
		const outside = (candidate.text as string)
			.match(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi)
			?.find((addr) => !/@example\.org$/i.test(addr));
		if (outside) {
			return {
				error: `"${outside}" is a real address. Use an address ending in @example.org, or the one you were given.`
			};
		}
	}
	if (action === 'press' && (typeof candidate.key !== 'string' || candidate.key === '')) {
		return { error: '"press" needs a "key", for example "Enter" or "Escape".' };
	}

	return {
		action: {
			do: action,
			ref: typeof candidate.ref === 'number' ? candidate.ref : undefined,
			text: typeof candidate.text === 'string' ? candidate.text : undefined,
			key: typeof candidate.key === 'string' ? candidate.key : undefined,
			why: candidate.why.trim()
		}
	};
}

/** Pages only a signed-in account has: its files, its account, its workspaces, its data and its saved
 *  instructions. A signed-in persona opens on one of them, so a scheduled run reaches a per-account
 *  surface even when the persona's own goal keeps it in the chat (CUR-2676).
 *  */
export const ACCOUNT_SURFACES = [
	'/chat/storage',
	'/chat/settings/account',
	'/chat/settings/workspace',
	'/chat/settings/data',
	'/chat/settings/personalization'
] as const;

/** The surface a persona opens on, stable for one seed so a rerun of the same run lands on the same
 *  page, and different across the personas in a run because the name is part of the seed. */
export function accountSurfaceFor(seed: string): (typeof ACCOUNT_SURFACES)[number] {
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return ACCOUNT_SURFACES[h % ACCOUNT_SURFACES.length];
}

// AnswerFooter.svelte's provenance button: "How this answer was made — <model>[ by <maker>][, served
// as the backup]. Opens X-ray." It is a label this app writes, so reading it is a shape check.
const PROVENANCE_LABEL =
	/^How this answer was made — (.+?)(?: by .+?)?(?:, served as the backup)?\. Opens X-ray\.$/;

/** Whether `url` is the `/alpha` demo, whose answers are sample data with their own provenance
 *  buttons: no request reached the model they credit. A persona that clicked
 *  into it would log its sample X-ray as a Mistral Large 3 turn (CUR-2676). */
export function isDemoPage(url: string): boolean {
	const path = new URL(url, 'http://x').pathname;
	return path === '/alpha' || path.startsWith('/alpha/');
}

/** The models the answers on screen credit, read from each answer's provenance button. */
export function servedModels(snapshot: SnapshotEntry[]): string[] {
	const names = snapshot.flatMap((e) => {
		const m = PROVENANCE_LABEL.exec(e.name);
		return m ? [m[1]] : [];
	});
	return [...new Set(names)];
}

// routing/choice.ts's per-device model choice. With the `auto-routing` flag on it decides a new
// chat's model and the account's saved default does not.
const MODEL_CHOICE_KEY = 'alpha:model-choice';

/** The catalog id the composer stores for a served model id: `mistral-large-2512` → `mistral-large`.
 *  The app reads back only an id its catalog lists and treats anything else as Auto, so the id comes
 *  from the catalog itself. Stripping the publisher off the gateway id matched GLM's row by
 *  coincidence and no other (CUR-3994). */
export function choiceIdFor(gatewayId: string): string {
	return catalogByGatewayId(gatewayId)?.id ?? servedKey(gatewayId);
}

/** Whether the composer's model pill (`aria-label="Model: <label>…"`) names the pinned model's
 *  family. "Auto", "Auto · Welsh" or another family all fail: a first send would not reach the pin. */
export function pillNamesModel(pillLabel: string, gatewayId: string): boolean {
	const family = choiceIdFor(gatewayId)
		.split('-')[0]
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^Model: ${family}\\b`, 'i').test(pillLabel);
}

/**
 * Pin `SCENARIO_MODEL` for this browser before the persona's first turn, and prove it from the
 * composer's model pill on `/chat`. Throws when the pill still names another model.
 *
 * A new chat takes its model from one of two places. The model page saves the account's default,
 * and the device's stored choice wins whenever Auto routing is on, so this sets both. Setting only one leaves a gap:
 * a persona's first chat can reach another model after the model-page visit alone,
 * and a persona that opens on an account page never visits the
 * model page and is answered by the default (CUR-2676).
 */
export async function pinScenarioModel(page: Page, name: string): Promise<void> {
	const model = process.env.SCENARIO_MODEL;
	if (!model) return;
	await page.goto(`/chat/models/${model}`, { waitUntil: 'load' });
	// The model page saves the default from onMount; wait for that write rather than for the clock.
	await page
		.waitForResponse(
			(r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/chat/settings',
			{ timeout: 15_000 }
		)
		.catch(() => undefined);
	await page.evaluate(
		([key, id]) => {
			try {
				localStorage.setItem(key, id);
			} catch {
				/* the pill check below says whether the pin held */
			}
		},
		[MODEL_CHOICE_KEY, choiceIdFor(model)] as const
	);
	await page.goto('/chat', { waitUntil: 'load' });
	// The server renders the pill as Auto and hydration swaps in the stored choice, so one read can land
	// before the swap. It would then read "Model: Auto" while the page already shows
	// "Model: Mistral" (SOL-164). Read until the pill names the model or 30 s pass.
	const pill = page.locator('[data-model-pill]').first();
	let label: string;
	const deadline = Date.now() + 30_000;
	do {
		label = (await pill.getAttribute('aria-label', { timeout: 30_000 })) ?? '';
		if (pillNamesModel(label, model)) break;
		await page.waitForTimeout(500);
	} while (Date.now() < deadline);
	console.error(`[persona pin] ${name}: ${model}, pill reads "${label}"`);
	if (!pillNamesModel(label, model)) {
		throw new Error(
			`${name}: the composer's model pill reads "${label}" after pinning ${model}, so the persona's ` +
				`first chat would reach another model (CUR-2676)`
		);
	}
}

/** The snapshot as the model sees it. Kept to one line per element so a long page stays readable and
 *  the ref is the first thing on the line — the model has to echo it back and a buried number gets
 *  mistyped. */
export function renderSnapshot(snapshot: SnapshotEntry[]): string {
	if (snapshot.length === 0) return '(nothing interactive is on the screen)';
	return snapshot
		.map((e) => `${e.ref}. ${e.role}${e.enabled ? '' : ' (disabled)'} — ${e.name || '(no label)'}`)
		.join('\n');
}

/** Menu, listbox and tab roles are here because bits-ui renders a menu's choices as `menuitem` and
 *  `menuitemradio` divs, not buttons: without them a driver could open the Tools menu and never pick
 *  "Read aloud: Always" (CUR-3557, CUR-3570). */
export const INTERACTIVE_SELECTOR = [
	'button',
	'a[href]',
	'input:not([type=hidden])',
	'textarea',
	'select',
	'[role=button]',
	'[role=link]',
	'[role=textbox]',
	'[role=switch]',
	'[role=checkbox]',
	'[role=radio]',
	'[role=menuitem]',
	'[role=menuitemradio]',
	'[role=menuitemcheckbox]',
	'[role=option]',
	'[role=tab]',
	'[contenteditable=true]'
].join(', ');

/** How many elements to show. A page with 200 controls is a prompt nobody can reason about, and the
 *  first N in DOM order is a defensible cut because the chat surface puts its controls near the top. */
const MAX_ELEMENTS = 40;

/** Where a control sits inside an open menu, listbox or modal dialog. Those are portaled to the end of
 *  `<body>`, so in plain DOM order they are the first thing the 40-element cut drops, and they are
 *  exactly what a driver who just opened one needs to see. */
export const POPUP_SELECTOR = '[role=menu], [role=listbox], [aria-modal="true"]';

/** DOM indexes in the order the snapshot considers them: controls inside an open popup first, then
 *  the rest, each group in DOM order. */
export function snapshotOrder(inPopup: boolean[]): number[] {
	const all = inPopup.map((_, i) => i);
	return [...all.filter((i) => inPopup[i]), ...all.filter((i) => !inPopup[i])];
}

/** What the snapshot needs from one matched element, read inside the page. */
export type ElementRow = {
	visible: boolean;
	inPopup: boolean;
	role: string;
	name: string;
	enabled: boolean;
};

/**
 * Reads every matched element in one pass. It runs inside the page through `evaluateAll`, so it must
 * stay self-contained: no reference to anything else in this module.
 *
 * @remarks Reading each element through its own `nth(i)` locator hung the driver for 19 minutes
 * (SOL-159): a menu closed between the query and the reads, the list shrank, and `evaluate` on an
 * index that no longer existed waited, with no timeout, until the test was killed. One read is one
 * consistent picture of the page and cannot wait on an element. Visibility follows Playwright's
 * `isVisible` (a non-empty box and not `visibility: hidden`), and enablement its `isEnabled`
 * (not `:disabled`, no `aria-disabled="true"` on the element or an ancestor).
 */
export function readElements(els: Element[], popup: string): ElementRow[] {
	const shown = (el: Element) => {
		const box = el.getBoundingClientRect();
		return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
	};
	// An open modal dialog covers everything else on the page (SOL-162): the Welcome to Alpha intro sat over
	// the chat for a whole walk while the driver clicked the controls underneath it. Menus and listboxes
	// opened from inside the modal portal to the end of <body>, so they stay readable.
	const modals = els[0]
		? [...els[0].ownerDocument.querySelectorAll('[aria-modal="true"]')].filter(shown)
		: [];
	const modal = modals.at(-1);
	return els.map((el) => {
		const covered =
			modal !== undefined &&
			!modal.contains(el) &&
			el.closest('[role=menu], [role=listbox]') === null;
		const visible = !covered && shown(el);
		const labelled =
			el.getAttribute('aria-label') ||
			el.getAttribute('placeholder') ||
			el.getAttribute('title') ||
			((el as HTMLElement).innerText ?? el.textContent) ||
			(el as HTMLInputElement).value ||
			'';
		return {
			visible,
			inPopup: el.closest(popup) !== null,
			role: el.getAttribute('role') || el.tagName.toLowerCase(),
			name: labelled.replace(/\s+/g, ' ').trim().slice(0, 80),
			enabled: !el.matches(':disabled') && el.closest('[aria-disabled="true"]') === null
		};
	});
}

export async function snapshotPage(page: Page): Promise<SnapshotEntry[]> {
	const rows = await page
		.locator(INTERACTIVE_SELECTOR)
		.evaluateAll(readElements, POPUP_SELECTOR)
		.catch((): ElementRow[] => []); // the page navigated mid-read; the next turn reads it again
	const entries: SnapshotEntry[] = [];
	for (const domIndex of snapshotOrder(rows.map((r) => r.inPopup))) {
		if (entries.length >= MAX_ELEMENTS) break;
		const { visible, role, name, enabled } = rows[domIndex];
		if (!visible) continue;
		entries.push({ ref: entries.length, domIndex, role, name, enabled });
	}
	return entries;
}

/**
 * Perform one validated action. Every failure is swallowed into the turn record rather than thrown:
 * a persona whose whole job is to do the wrong thing will routinely click something that detaches
 * mid-click, and a thrown error there would end the run and destroy the recording — which is the
 * artifact this exists to produce.
 */
export async function perform(
	page: Page,
	action: PersonaAction,
	snapshot: SnapshotEntry[]
): Promise<string | undefined> {
	const entry = action.ref === undefined ? undefined : snapshot.find((e) => e.ref === action.ref);
	const target = entry ? page.locator(INTERACTIVE_SELECTOR).nth(entry.domIndex) : null;
	try {
		// SCROLL THE TARGET INTO VIEW BEFORE ACTING, and the reason is the recording rather than the
		// click. Without it the video shows
		// the page's intro block throughout: the composer sits below the fold on a
		// fresh chat page, and `click({force: true})` skips the actionability checks that would
		// otherwise have scrolled to it. Every action lands and the frames the critic reads show
		// none of them. A persona whose recording does not show what it did produces nothing,
		// however correct its trace.
		if (target) await target.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
		switch (action.do) {
			case 'click':
				await target!.click({ timeout: 5_000, force: true });
				break;
			case 'fill':
				await target!.fill(action.text!, { timeout: 5_000 });
				break;
			case 'press':
				await target!.press(action.key!, { timeout: 5_000 });
				break;
			case 'reload':
				await page.reload({ waitUntil: 'commit', timeout: 15_000 });
				break;
			case 'back':
				await page.goBack({ waitUntil: 'commit', timeout: 15_000 });
				break;
			case 'wait':
				await page.waitForTimeout(2_000);
				break;
			case 'check_inbox':
				break; // read by runPersona, which holds the inbox
		}
	} catch (err) {
		return err instanceof Error ? err.message.split('\n')[0] : String(err);
	}
	return undefined;
}

/** The text lane, resolved once per run. `error` rather than a throw, so a spec can skip with the
 *  reason stated instead of failing for a missing credential. An absent model is a fact about the
 *  run's coverage, and the gallery already has a state that says so in those words. */
export function resolvePersonaLane():
	| { provider: 'anthropic' | 'gateway'; apiKey: string; model: string; baseURL?: string }
	| { error: string } {
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		return {
			provider: 'anthropic',
			apiKey: anthropicKey,
			model: process.env.PERSONA_MODEL || 'claude-sonnet-5'
		};
	}
	const baseURL = process.env.OPENAI_BASE_URL;
	const apiKey = process.env.OPENAI_API_KEY;
	const model = process.env.PERSONA_MODEL;
	if (!baseURL || !apiKey || !model) {
		return {
			error:
				'no text model lane — set ANTHROPIC_API_KEY, or all of OPENAI_BASE_URL, OPENAI_API_KEY ' +
				'and PERSONA_MODEL. PERSONA_MODEL has no default on the gateway on purpose: the pool ' +
				'composition drifts, and a hardcoded id that silently stops resolving is worse than a skip ' +
				'that says why.'
		};
	}
	return { provider: 'gateway', apiKey, model, baseURL };
}

type Lane = Exclude<ReturnType<typeof resolvePersonaLane>, { error: string }>;

/**
 * THE API ENFORCES THE SHAPE, so the prompt only has to say what to choose.
 *
 * Both lanes ask for this through their structured-output path — a forced tool call — instead of
 * describing JSON in prose and parsing whatever comes back. The decoder is constrained to the
 * schema: `do` is confined to the vocabulary, `ref` arrives as a number, and there is no fence,
 * preamble or apology to strip. A prose request would need a fence-and-brace
 * extractor to cope with the answers; that extractor survives only for the gateway's degraded
 * path.
 *
 * `required` lists only `do` and `why` even though click, fill and press each need more, because
 * JSON Schema cannot express "ref is required when do is one of these three" in a form every
 * provider honours. That conditional lives in `validateAction`, which is the right place for it
 * anyway — see the next paragraph.
 *
 * WHAT A SCHEMA CANNOT DO, and the reason `validateAction` does not go away: no schema can say that
 * `ref: 7` names something on THIS screen. Structured output buys a well-formed object. The rule
 * this whole driver rests on is about the object being TRUE of the page in front of it, and that is
 * checkable only against the snapshot.
 */
export const actionSchema = (allowed: readonly ActionName[]) => ({
	type: 'object',
	properties: {
		do: {
			type: 'string',
			enum: [...allowed],
			description:
				'click, fill and press act on one element and need a ref. reload, back and wait act on the page. check_inbox, when offered, shows the latest sign-in code sent to your own address.'
		},
		ref: {
			type: 'integer',
			description:
				'Required for click, fill and press. A number from the list you were given THIS turn — refs are renumbered every turn, so a number you used earlier points at something else now.'
		},
		text: { type: 'string', description: 'Required for fill. What to type.' },
		key: { type: 'string', description: 'Required for press, for example "Enter" or "Escape".' },
		why: {
			type: 'string',
			description: 'One sentence on what you expect to happen. What you expect, not what you hope.'
		}
	},
	required: ['do', 'why'],
	additionalProperties: false
});

const TOOL_NAME = 'choose_action';
const TOOL_DESCRIPTION = 'Choose the single next action to perform on the page.';

async function askModel(
	lane: Lane,
	systemPrompt: string,
	userText: string,
	allowed: readonly ActionName[]
): Promise<unknown> {
	if (lane.provider === 'anthropic') {
		// Deliberately uncached (CUR-2072). Every call is one fresh user message, so the only span
		// shared across turns is tools + system, about 1,160 tokens. On
		// claude-sonnet-5: a marker on `system` wrote 0 and read 0 on identical-prefix calls; a
		// marker on the user message wrote ~1,225 every turn and read 0 on the next, since the
		// snapshot differs. Either marker costs more than it saves, and a whole run is ~16k input
		// tokens. Caching here needs a real multi-turn history, which the stale-ref rule below
		// argues against.
		const out = await anthropicToolCall({
			apiKey: lane.apiKey,
			model: lane.model,
			system: systemPrompt,
			user: userText,
			tools: [
				{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: actionSchema(allowed) }
			],
			choice: { type: 'tool', name: TOOL_NAME },
			maxTokens: 600,
			cacheSystem: false,
			logTag: 'persona usage'
		});
		return out?.input ?? null;
	}

	// The gateway is a LiteLLM pool whose composition drifts, and tool support is per-model rather
	// than per-gateway — so the strict path is attempted and a 4xx falls back to plain text plus the
	// extractor below. Falling back loudly would be wrong here: a model with no tool support still
	// produces a usable persona, just a weaker one, and the trace records what it chose either way.
	const call = async (withTools: boolean) => {
		const res = await fetch(`${lane.baseURL!.replace(/\/$/, '')}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${lane.apiKey}` },
			body: JSON.stringify({
				model: lane.model,
				max_tokens: 600,
				temperature: 1,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userText }
				],
				...(withTools
					? {
							tools: [
								{
									type: 'function',
									function: {
										name: TOOL_NAME,
										description: TOOL_DESCRIPTION,
										parameters: actionSchema(allowed)
									}
								}
							],
							tool_choice: { type: 'function', function: { name: TOOL_NAME } }
						}
					: {})
			})
		});
		if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 500)}`);
		return (await res.json()) as {
			choices?: {
				message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] };
			}[];
		};
	};

	let data;
	try {
		data = await call(true);
	} catch {
		data = await call(false);
	}
	const message = data.choices?.[0]?.message;
	const args = message?.tool_calls?.[0]?.function?.arguments;
	if (typeof args === 'string') return safeParse(args);
	return extractJson(message?.content ?? '');
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** The degraded path only: a gateway model with no tool support answers in prose and sometimes
 *  fences the object. Extract rather than reject — a persona that forfeits its turn over a code
 *  fence is a persona that mostly waits. Nothing on the Anthropic lane reaches this. */
export function extractJson(raw: string): unknown {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : raw).trim();
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	return safeParse(body.slice(start, end + 1));
}

/** Turns per run. Twelve is the default because a persona needs room to build on what it just did —
 *  a grind is not visible in three. `PERSONA_TURNS` exists for the live smoke check, where the
 *  question is whether the driver works at all and twelve model round-trips is a slow way to ask. */
export function personaTurns(fallback: number): number {
	const raw = Number(process.env.PERSONA_TURNS);
	return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export type PersonaRunOptions = {
	page: Page;
	testInfo: TestInfo;
	name: string;
	systemPrompt: string;
	startUrl: string;
	turns: number;
	lane: Lane;
	/** What this tester may do; every action when omitted. Narrowed for a persona defined by a
	 *  constraint, such as keyboard-only (CUR-2676). */
	actions?: readonly ActionName[];
	/** What `check_inbox` reads: the latest sign-in code for the persona's own test address, or a line
	 *  saying none has arrived. Required when `actions` includes `check_inbox`. */
	inbox?: () => Promise<string>;
	/** Open on one of ACCOUNT_SURFACES instead of `startUrl`. Only for a persona that is already
	 *  signed in; the persona reaches the chat from there through the rail, as a person would. */
	openOnAccountSurface?: boolean;
};

/**
 * Run a persona for `turns` turns and attach the trace.
 *
 * Returns the trace rather than asserting on it. What counts as a defect is not this driver's
 * judgement to make — that is the PM critic's job, against the recording this produces. A driver that
 * decided for itself what was wrong would be a second rubric nobody asked for, and the two would
 * disagree.
 */
export async function runPersona(opts: PersonaRunOptions): Promise<TurnRecord[]> {
	const {
		page,
		testInfo,
		name,
		systemPrompt,
		startUrl,
		turns,
		lane,
		actions = DEFAULT_ACTIONS,
		inbox,
		openOnAccountSurface = false
	} = opts;
	if (actions.includes('check_inbox') && !inbox) {
		throw new Error(`persona ${name} offers check_inbox but was given no inbox to read`);
	}
	const trace: TurnRecord[] = [];
	let inboxNote = '';

	// A positive control for the refusal tripwire, once per run (CUR-2676). A unit test proves the rule;
	// this proves the build that is about to type unattended still carries it, and leaves the log
	// line a reader can find. A canned input that is NOT refused stops the run before turn 1.
	const control = validateAction(
		{ do: 'fill', ref: 0, text: CANNED_REFUSAL_CONTROL, why: 'refusal control' },
		[{ ref: 0, domIndex: 0, role: 'textarea', name: 'control', enabled: true }]
	);
	if (!('error' in control) || !control.error.startsWith(REFUSAL_PREFIX)) {
		throw new Error(
			`the refusal tripwire let a canned forbidden input through: ${CANNED_REFUSAL_CONTROL}`
		);
	}
	console.error(`[persona refused] ${name} control: ${control.error}`);

	await pinScenarioModel(page, name);

	if (openOnAccountSurface) {
		const surface = accountSurfaceFor(`${process.env.GITHUB_RUN_ID ?? 'local'}:${name}`);
		await page.goto(surface, { waitUntil: 'commit' });
		await page.waitForLoadState('domcontentloaded');
		// A redirect away from the surface (to sign-in, or home) is logged, not thrown: the persona
		// still runs, and the line says the account surface was out of reach on this build.
		const landed = new URL(page.url()).pathname;
		console.error(
			`[persona surface] ${name}: ${surface}${landed === surface ? '' : ` redirected to ${landed}`}`
		);
	} else {
		await page.goto(startUrl, { waitUntil: 'commit' });
	}

	const served = new Set<string>();
	for (let turn = 1; turn <= turns; turn++) {
		const snapshot = await snapshotPage(page);
		const record: TurnRecord = { turn, snapshot, url: page.url(), rejected: [] };
		for (const model of isDemoPage(page.url()) ? [] : servedModels(snapshot)) {
			if (served.has(model)) continue;
			served.add(model);
			console.error(`[persona served] ${name} turn ${turn}: ${model}`);
		}

		// The history names the ELEMENT, never the ref that pointed at it. Refs are renumbered from
		// zero on every turn against that turn's visible elements, so `19` can be "Forget everything"
		// on turn 2 and a preset prompt on turn 5, so the persona can click one while describing
		// the other. Feeding a stale ref
		// back into the prompt would teach it that refs persist. The label does not go stale.
		const history = trace
			.slice(-4)
			.map((t) => {
				if (!t.action) return `turn ${t.turn}: (no action)`;
				const label = t.snapshot.find((e) => e.ref === t.action!.ref)?.name;
				const what = label ? `${t.action.do} "${label}"` : t.action.do;
				return `turn ${t.turn}: ${what} — ${t.action.why}`;
			})
			.join('\n');

		let chosen: PersonaAction | undefined;
		for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
			const userText = [
				`You are on ${page.url()}, turn ${turn} of ${turns}.`,
				'',
				'ON THE SCREEN RIGHT NOW:',
				renderSnapshot(snapshot),
				'',
				history ? `WHAT YOU HAVE DONE SO FAR:\n${history}` : '',
				inboxNote ? `YOUR INBOX, LAST CHECKED: ${inboxNote}` : '',
				record.rejected!.length ? `YOUR LAST REPLY WAS REJECTED: ${record.rejected!.at(-1)}` : ''
			]
				.filter(Boolean)
				.join('\n');

			// No reply-format instructions here. The tool schema carries the shape and the
			// per-field descriptions carry the conditional rules, so repeating them in prose would be a
			// second copy to drift out of step with the first.
			let reply: unknown;
			try {
				reply = await askModel(lane, systemPrompt, userText, actions);
			} catch (err) {
				record.error = err instanceof Error ? err.message : String(err);
				break;
			}
			const verdict = validateAction(reply, snapshot, actions);
			if ('error' in verdict) {
				record.rejected!.push(verdict.error);
				// One line per refusal, so a run's log proves the tripwire fired (CUR-2676).
				if (verdict.error.startsWith(REFUSAL_PREFIX))
					console.error(`[persona refused] ${name} turn ${turn}: ${verdict.error}`);
			} else chosen = verdict.action;
		}

		if (chosen) {
			record.action = chosen;
			const entry = snapshot.find((e) => e.ref === chosen!.ref);
			if (entry) record.acted = `${entry.role} "${entry.name}"`;
			if (chosen.do === 'check_inbox') {
				inboxNote = await inbox!().catch((err) => `could not read the inbox: ${String(err)}`);
				record.acted = `inbox: ${inboxNote}`;
			} else {
				const failure = await perform(page, chosen, snapshot);
				if (failure) record.error = failure;
			}
		}
		trace.push(record);
		if (record.error && !chosen) break; // the lane itself is down; more turns buy nothing
	}

	await testInfo.attach('persona-trace', {
		body: JSON.stringify(
			{ persona: name, model: lane.model, provider: lane.provider, trace },
			null,
			2
		),
		contentType: 'application/json'
	});
	// Large 3 takes no scheduled traffic. validateAction stops
	// the persona choosing it; this catches a turn that reached it anyway, through a default or a
	// fallback, after the trace is attached so the run that broke the rule is still readable.
	const offLimits = [...served].filter((m) => OFF_LIMITS_TARGET.test(m));
	if (offLimits.length) {
		throw new Error(
			`persona ${name} was answered by ${offLimits.join(', ')}, which takes no scheduled traffic`
		);
	}
	return trace;
}
