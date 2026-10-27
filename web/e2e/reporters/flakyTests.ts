// playwright.config.ts sets `retries: 1` on CI, and until this reporter existed nothing
// read the outcome that retry produces. A test that failed its first attempt and passed its second
// is reported by every other reporter in the list as a plain pass — `github` annotates only real
// failures, `list` prints a tick, and the job's conclusion is success. The information that the
// suite needed two attempts to get there was computed by Playwright and then discarded.
//
// A green suite that quietly needed a second attempt reads identically to a healthy one: the same
// defect class as any check whose output is the same in the healthy and the unhealthy case.
//
// This reporter never fails a run. Being flaky is a fact to surface, not a verdict to enforce —
// the enforcement question (quarantine, a rate threshold, retries off entirely) needs cross-run
// history that nothing here stores yet. What it does is make the fact impossible to miss in the
// run that produced it, and write one machine-readable line per flaky test so the history layer
// has something to read when it arrives.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** One JSONL line per flaky test. Deliberately append-only and per-run: a future flake-RATE store
 *  reads a directory of these, and nothing here has to decide what the retention window is. */
export const FLAKY_LOG = join(process.cwd(), 'test-results', 'flaky.jsonl');

interface FlakyRecord {
	title: string;
	spec: string;
	line: number;
	attempts: number;
	firstFailure: string;
	runId: string | undefined;
	sha: string | undefined;
	at: string;
}

/** The first attempt's error, trimmed to one line. The whole point is telling two flakes apart at a
 *  glance — a timeout and an assertion failure on the same test are different bugs — so this keeps
 *  the message and drops the stack, which is already in the trace attachment. */
export function firstFailureLine(results: TestResult[]): string {
	const failed = results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
	const raw = failed?.error?.message ?? failed?.status ?? 'unknown';
	return String(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** GitHub resolves an annotation's `file=` against the REPOSITORY root, while this suite runs with
 *  its working directory set to `web/` — so a path relative to cwd lands the annotation on a file
 *  that does not exist and it silently renders nowhere. `GITHUB_WORKSPACE` is the checkout root on a
 *  runner; off a runner there is no annotation to place, so cwd is the honest fallback. */
export function repoRelative(absPath: string): string {
	return relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), absPath);
}

export default class FlakyTestsReporter implements Reporter {
	private flaky: FlakyRecord[] = [];

	onTestEnd(test: TestCase, result: TestResult): void {
		// `test.outcome()` is the whole-test verdict across every attempt, so it is only meaningful
		// once the final attempt has ended. Playwright calls onTestEnd per attempt; a retried test
		// reads 'flaky' on the last one and 'unexpected' on the first, which is why this checks the
		// outcome rather than `result.status` or `result.retry`.
		if (test.outcome() !== 'flaky') return;
		// A retried-and-still-failing test is 'unexpected', not 'flaky', so it cannot reach here —
		// that one is already a red run and needs no help being noticed.
		this.flaky.push({
			// `titlePath()` leads with the project name, which is '' whenever the config declares no
			// `projects` — filtering empties is correct in both shapes, where a fixed `.slice(1)` left
			// a leading ' › ' on one of them.
			title: test.titlePath().filter(Boolean).join(' › '),
			spec: repoRelative(test.location.file),
			line: test.location.line,
			attempts: result.retry + 1,
			firstFailure: firstFailureLine(test.results),
			runId: process.env.GITHUB_RUN_ID,
			sha: process.env.GITHUB_SHA,
			at: new Date().toISOString()
		});
	}

	onEnd(): void {
		if (this.flaky.length === 0) return;

		for (const f of this.flaky) {
			// `::warning file=...,line=...` puts the annotation on the spec line in the PR's Files
			// tab, next to the test, rather than only in the job log where it scrolls away.
			console.log(
				`::warning file=${f.spec},line=${f.line}::FLAKY — "${f.title}" passed only on attempt ` +
					`${f.attempts}. Its first attempt failed with: ${f.firstFailure}. This run is green and the ` +
					`suite needed a retry to get there, so treat a pass here as weaker evidence than a clean one.`
			);
		}

		const plural = this.flaky.length === 1 ? 'test' : 'tests';
		console.log(
			`::notice::${this.flaky.length} flaky ${plural} in this run — green, but only after a retry. ` +
				`See the per-test warnings above.`
		);

		try {
			mkdirSync(dirname(FLAKY_LOG), { recursive: true });
			appendFileSync(FLAKY_LOG, this.flaky.map((f) => JSON.stringify(f)).join('\n') + '\n');
		} catch {
			// Best-effort, exactly like errorTracking.ts: a reporter that throws takes the run down
			// with it, and losing the history line is not worth losing the run.
		}

		const summary = process.env.GITHUB_STEP_SUMMARY;
		if (!summary) return;
		try {
			writeFileSync(
				summary,
				[
					`### ${this.flaky.length} flaky ${plural}`,
					'',
					'| test | attempts | first failure |',
					'| --- | --- | --- |',
					...this.flaky.map(
						(f) => `| \`${f.title}\` | ${f.attempts} | ${f.firstFailure.replace(/\|/g, '\\|')} |`
					),
					''
				].join('\n'),
				{ flag: 'a' }
			);
		} catch {
			// Same reasoning as above.
		}
	}
}
