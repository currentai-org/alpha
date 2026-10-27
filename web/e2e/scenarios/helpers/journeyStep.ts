// Marks the part of a recording that walks one row of a journey doc's steps table, so the
// tour reel can cut that row out of the test's video instead of playing the whole test, sign-in and
// seeding included.
//
// The title is the one shape `stepSpans` in reporters/journeyArtifacts.ts reads back: `<journey> step
// <row>`, with an optional note after a colon for a human reading the Playwright report. The caption
// a viewer sees comes from the doc's own row, not from here, so the doc stays the one place the words
// live.
//
// When the row's body finishes, the page's accessibility snapshot is attached under
// `journey-step:<journey>:<row>`. The reporter files it beside that row's span in meta.json, so the
// grader reads what the screen said as text, not only as a sampled frame at 1024 px. A snapshot that
// cannot be taken is attached as a one-line note and never fails the test, since the snapshot is
// evidence for the grader and asserts nothing. A row whose body throws still gets its snapshot, headed
// by the failure's first line: the screen a broken row left behind is the evidence the grader most
// needs, and the error is rethrown unchanged. A visit's note heads its snapshot too
// (`journeyStepSnapshot.ts`), for an action like a reload that leaves the screen unchanged.
//
// `box: true` so a failure inside reports the caller's line, not this file's.
import { test, type Page } from '@playwright/test';
import { snapshotBody } from './journeyStepSnapshot';

const JOURNEY_STEP_SNAPSHOT_PREFIX = 'journey-step:';

const SNAPSHOT_TIMEOUT_MS = 5_000;

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0];

async function attachSnapshot(
	page: Page,
	journey: string,
	row: number,
	note?: string,
	failure?: unknown
): Promise<void> {
	let text: string;
	try {
		text = await page.locator('body').ariaSnapshot({ timeout: SNAPSHOT_TIMEOUT_MS });
	} catch (err) {
		text = `(no snapshot: ${firstLine(err)})`;
	}
	await test.info().attach(`${JOURNEY_STEP_SNAPSHOT_PREFIX}${journey}:${row}`, {
		body: snapshotBody(text, note, failure === undefined ? undefined : firstLine(failure)),
		contentType: 'text/plain'
	});
}

export function journeyStep<T>(
	page: Page,
	journey: string,
	row: number,
	body: () => Promise<T>,
	note?: string
): Promise<T> {
	return test.step(
		`${journey} step ${row}${note ? `: ${note}` : ''}`,
		async () => {
			let out: T;
			try {
				out = await body();
			} catch (err) {
				await attachSnapshot(page, journey, row, note, err).catch(() => {});
				throw err;
			}
			await attachSnapshot(page, journey, row, note);
			return out;
		},
		{ box: true }
	);
}
