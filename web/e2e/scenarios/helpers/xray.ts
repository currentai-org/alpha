import type { Locator, Page } from '@playwright/test';

// An answer's sources live in XRAY (the composer's X-ray panel), not inline under the answer: its
// footer's "How this answer was made" opens the panel on that answer, and the "Step by step" tab
// lists each step's sources behind a "See N sources" toggle (StepByStep.svelte). A linked page is a
// web source titled "Linked page: …" (openSearch.ts), so it reads as a link with that name there.
//
// Opens all of that for `answer` and returns once every source list is expanded. Throws on a step
// that is not there, so the caller's own `expect` inside `toPass` retries the whole walk.

/** Per-step deadlines, passed by the spec so they stay visible there (e2e-scope-classify.mjs). */
export interface OpenSourcesTimeouts {
	/** "How this answer was made", which opens XRAY on the answer. */
	disclosure: { timeout: number };
	/** The "Step by step" tab. */
	tab: { timeout: number };
	/** Each "See N sources" toggle. */
	sources: { timeout: number };
}

type OpenTabTimeouts = Pick<OpenSourcesTimeouts, 'disclosure' | 'tab'> & {
	/** Reading whether XRAY is already open on it; the disclosure's deadline when unset. */
	expanded?: { timeout: number };
};

/** Opens XRAY on `answer` and switches it to `tab` ("This answer", "Step by step", "The stack"). */
export async function openXrayTab(
	page: Page,
	answer: Locator,
	tab: string,
	timeouts: OpenTabTimeouts
): Promise<void> {
	const howMade = answer.getByRole('button', { name: /How this answer was made/ });
	const expanded = timeouts.expanded ?? timeouts.disclosure;
	if ((await howMade.getAttribute('aria-expanded', expanded)) !== 'true') {
		await howMade.click(timeouts.disclosure);
	}
	await page.getByRole('tab', { name: tab }).click(timeouts.tab);
}

/** Opens XRAY on `answer` and switches it to the "Step by step" tab. */
export async function openStepByStep(
	page: Page,
	answer: Locator,
	timeouts: OpenTabTimeouts
): Promise<void> {
	await openXrayTab(page, answer, 'Step by step', timeouts);
}

/** Opens XRAY's step-by-step view on `answer` and expands every step's source list. */
export async function openAnswerSources(
	page: Page,
	answer: Locator,
	timeouts: OpenSourcesTimeouts
): Promise<void> {
	await openStepByStep(page, answer, timeouts);
	const closed = page.getByRole('button', { name: /^See \d+ sources?$/ });
	for (let i = await closed.count(); i > 0; i--) {
		await closed.first().click(timeouts.sources);
	}
}
