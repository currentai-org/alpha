// journey-gallery.yml's "Fail the job if the scenario suite itself failed" step reads only
// Playwright's own process exit code, which is 0 as long as every test eventually passed or was
// skipped — retries and skips are computed by Playwright and then discarded, the same defect
// flakyTests.ts (CUR-1509) already fixed for flakiness alone. A SKIPPED tagged test is invisible
// everywhere else in this pipeline too: journeyArtifacts.ts only writes a recording's meta.json when
// a video attachment exists, and a skipped test never produces one — so a skip leaves no trace this
// repo's own reporters, or the gallery they feed, ever see.
//
// This reporter is the one place that watches every JOURNEY-TAGGED test's final outcome, including
// It does not decide what a skip or a retry should DO to the commit check — that is a policy
// question for the step that reads its output — it only makes the fact visible to that step.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { JOURNEY_TAG_RE } from './journeyArtifacts';

export const TAGGED_OUTCOMES_LOG = join(process.cwd(), 'test-results', 'tagged-outcomes.json');

export interface TaggedOutcome {
	journey: string;
	title: string;
	spec: string;
	line: number;
	// Playwright's own whole-test verdict: 'expected' | 'unexpected' | 'flaky' | 'skipped'.
	outcome: string;
	// The final attempt's own status, kept alongside `outcome` because 'unexpected' alone doesn't say
	// whether the test failed or timed out.
	status: string;
	attempts: number;
}

// GitHub resolves an annotation's `file=` against the repository root, while this suite runs with its
// working directory set to `web/` — the same fix flakyTests.ts already needed for the same reason.
function repoRelative(absPath: string): string {
	return relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), absPath);
}

export default class TaggedOutcomesReporter implements Reporter {
	// Keyed by test id: onTestEnd fires once per ATTEMPT, and a retried test's earlier attempts read
	// 'unexpected' before its outcome resolves — keying on id means the last attempt simply overwrites
	// the row rather than accumulating one phantom entry per attempt.
	private outcomes = new Map<string, TaggedOutcome>();

	onTestEnd(test: TestCase, result: TestResult): void {
		const journeyTag = test.tags.find((t) => JOURNEY_TAG_RE.test(t));
		if (!journeyTag) return;

		this.outcomes.set(test.id, {
			journey: journeyTag.slice(1),
			title: test.titlePath().filter(Boolean).join(' › '),
			spec: repoRelative(test.location.file),
			line: test.location.line,
			outcome: test.outcome(),
			status: result.status,
			attempts: result.retry + 1
		});
	}

	// Always written, even when no tagged test ran at all — an empty array and a missing file are two
	// different facts (nothing tagged ran, versus this reporter never fired), and collapsing them into
	// one is the exact defect class this repo's own gates keep getting caught by.
	onEnd(): void {
		mkdirSync(dirname(TAGGED_OUTCOMES_LOG), { recursive: true });
		writeFileSync(TAGGED_OUTCOMES_LOG, JSON.stringify([...this.outcomes.values()], null, 2) + '\n');
	}
}
