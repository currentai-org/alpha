import type { Page } from '@playwright/test';
import { PICKER } from '../../../config/picker';

// A live scenario that fails because one upstream model did not answer, or that only ever
// chatted with a model nobody gets by default, says nothing about whether this build works. The
// fixture in test.ts records which models a test started chats on and, after a failed attempt, whether
// the page shows our own timed-out notice. quarantineOutcomes.ts turns those annotations into an
// `advisory` reason, and journey-gallery.yml's fail step passes a run whose every failure is
// quarantined or advisory. Off unless GRADE_MODEL_ADVISORY=1, which the gallery and
// scenario-suite-check.yml's develop push run set. On that push run, upstream-probe.mjs names
// the models whose direct call failed in SCENARIO_UPSTREAM_DOWN, and a test that chatted only with
// those is advisory even when the push changed the harness.

export const CHAT_MODELS_ANNOTATION = 'chat-models';
export const UPSTREAM_UNANSWERED_ANNOTATION = 'upstream-unanswered';

/**
 * How the timed-out notice ends (timedOutMessage in upstreamSilent.ts). upstreamSilent.spec.ts fails
 * if the two drift apart.
 */
export const TIMED_OUT_SUFFIX = ' took too long to respond. Please try again.';

/**
 * The opening of the generic sentence, which the watchdog shows when one of our own steps stalled
 * (CUR-4107). That is our failure, so it never counts as an upstream that did not answer.
 */
export const OWN_STALL_PREFIX = 'The request';

/** Whether `text` holds the named notice, "<model> took too long…", as opposed to the generic one. */
export function namesASilentModel(text: string): boolean {
	return text.split('\n').some((line) => {
		const at = line.indexOf(TIMED_OUT_SUFFIX);
		return at > 0 && !line.slice(0, at).trim().endsWith(OWN_STALL_PREFIX);
	});
}

/** Whether any of `pages` shows the named timed-out notice. Same 2 s bound as mockAnswerShown. */
export async function upstreamNoticeShown(pages: Page[]): Promise<boolean> {
	const bodyText = (p: Page) =>
		Promise.race([
			p.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
			new Promise<string>((done) => setTimeout(() => done(''), 2_000))
		]);
	const shown = await Promise.all(pages.map(bodyText));
	return shown.some(namesASilentModel);
}

/** The models whose failures always block: every site's default (the first picker entry). */
export function blockingModels(): Set<string> {
	return new Set(Object.values(PICKER).map((list) => list[0]));
}

type Annotation = { type: string; description?: string };

/** The model ids a test started chats on, from the fixture's annotation. */
function chatModels(annotations: readonly Annotation[]): string[] {
	return annotations
		.filter((a) => a.type === CHAT_MODELS_ANNOTATION)
		.flatMap((a) => (a.description ?? '').split(','))
		.map((m) => m.trim())
		.filter(Boolean);
}

/**
 * Whether a passing test got an answer from a default model. The gallery's fail step requires at least
 * one such test in the run before it waves any failure through: a change that breaks every default
 * turn times out every default test, and with none answered the timeouts stay red.
 */
export function measuredDefault(
	annotations: readonly Annotation[],
	blocking: Set<string> = blockingModels()
): boolean {
	return chatModels(annotations).some((m) => blocking.has(m));
}

/**
 * Why a failed test does not block the grade, or null when it does.
 *
 * - `upstream-unanswered`: the page named a model that never answered, so the turn was never measured.
 * - `non-default-model:<ids>`: every chat the test started was on a model outside `blocking`.
 * - `upstream-down:<ids>`: every chat the test started was on a model whose direct call failed before
 *   the suite (upstream-probe.mjs, SOL-367). This one holds even when `allModelsBlock` is set: the probe
 *   bypassed our code, so the failure is the host's, whatever the push changed.
 *
 * `allModelsBlock` is set when the promotion's diff changes model config or the harness, so that no
 * failure, a timeout included, can be waved through on the run that changed it.
 */
export function advisoryReason(
	annotations: readonly Annotation[],
	opts: {
		enabled: boolean;
		allModelsBlock: boolean;
		blocking?: Set<string>;
		upstreamDown?: Set<string>;
	}
): string | null {
	if (!opts.enabled) return null;
	const models = chatModels(annotations);
	const down = opts.upstreamDown;
	if (down?.size && models.length > 0 && models.every((m) => down.has(m)))
		return `upstream-down:${[...new Set(models)].join(',')}`;
	// A diff that changes model config or the harness is the one run where a timeout may be ours, so
	// nothing is waved through on it, timeouts included.
	if (opts.allModelsBlock) return null;
	if (annotations.some((a) => a.type === UPSTREAM_UNANSWERED_ANNOTATION))
		return 'upstream-unanswered';
	if (models.length === 0) return null;
	const blocking = opts.blocking ?? blockingModels();
	if (models.some((m) => blocking.has(m))) return null;
	return `non-default-model:${[...new Set(models)].join(',')}`;
}
