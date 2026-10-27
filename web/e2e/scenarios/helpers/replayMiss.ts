import { basename } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

// A PR that edits per-turn prompt text (the facts block rides in the last user message) misses
// every recording, so each replayed turn gets a mock answer and the specs that read the answer go red.
// The fixture in test.ts asks `mockAnswerShown` after a failed attempt in mock mode and, when it says
// yes, prints `replayMissLine` to the suite log; record-scenario-failures.mjs then marks that test's
// ledger row `replayMiss` (replayMissFromLog in scripts/lib/sharedScenarioFailures.mjs reads the line).

/** How every mock answer opens (MOCK_ANSWER in modelReplay.ts). */
export const MOCK_ANSWER_MARK = '[mock answer]';

/**
 * Whether any of `pages` shows a mock answer. A page that is closed, crashed or slower than 2 s to answer
 * counts as not showing one, so a hung page cannot stall the fixture's teardown. A mock that fed a step
 * the page never shows (a planner, a search query) is not seen here, and that red stays the PR's.
 */
export async function mockAnswerShown(pages: Page[]): Promise<boolean> {
	const bodyText = (p: Page) =>
		Promise.race([
			p.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
			new Promise<string>((done) => setTimeout(() => done(''), 2_000))
		]);
	const shown = await Promise.all(pages.map(bodyText));
	return shown.some((t) => t.includes(MOCK_ANSWER_MARK));
}

/** The suite-log line naming a failed attempt a mock answered. */
export function replayMissLine(testInfo: Pick<TestInfo, 'file' | 'line' | 'retry'>): string {
	return `scenario-replay-miss: ${basename(testInfo.file)}:${testInfo.line} retry=${testInfo.retry}`;
}
