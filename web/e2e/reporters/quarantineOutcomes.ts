// Develop's post-merge run (journey-gallery.yml) keeps running every quarantined scenario, so each
// one goes on reporting while its owner ticket is open (CUR-2445). That run fails
// its job on any nonzero suite exit, though, so without this file a quarantined flake would turn
// develop red exactly as before.
//
// This writes every failed test of the run with the quarantine entry it matched, if any. The
// gallery's fail step reads it: when every failure was quarantined it warns and passes, and anything
// else (an unquarantined failure, or this file missing) keeps it red. The file is written on every
// run, failures or not, so "missing" can only mean the reporter never ran.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { matchingEntry, readQuarantine } from '../quarantine.mjs';
import { advisoryReason, measuredDefault } from '../scenarios/helpers/upstreamAdvisory';

export const QUARANTINE_OUTCOMES = join(process.cwd(), 'test-results', 'quarantine-outcomes.json');

/** The same string Playwright's grep and grepInvert match, so a match here is a match there. */
export const grepTitle = (test: TestCase): string => [...test.titlePath(), ...test.tags].join(' ');

export default class QuarantineOutcomesReporter implements Reporter {
	private root: Suite | undefined;

	onBegin(_config: unknown, suite: Suite): void {
		this.root = suite;
	}

	onEnd(result: FullResult): void {
		let entries: ReturnType<typeof readQuarantine> = [];
		try {
			entries = readQuarantine();
		} catch {
			// An unreadable file quarantines nothing, which keeps every failure red. The static check
			// is where a broken file gets reported.
		}
		// The gallery and the develop push run set GRADE_MODEL_ADVISORY=1, and
		// GRADE_ALL_MODELS_BLOCK=1 when the diff changes model config or the harness. Every other run
		// leaves `advisory` null. SOL-367: SCENARIO_UPSTREAM_DOWN lists the models whose direct call
		// failed before the suite (upstream-probe.mjs).
		const advisoryOpts = {
			enabled: process.env.GRADE_MODEL_ADVISORY === '1',
			allModelsBlock: process.env.GRADE_ALL_MODELS_BLOCK === '1',
			upstreamDown: new Set(
				(process.env.SCENARIO_UPSTREAM_DOWN ?? '')
					.split(',')
					.map((m) => m.trim())
					.filter(Boolean)
			)
		};
		const failures = (this.root?.allTests() ?? [])
			.filter((t) => t.outcome() === 'unexpected')
			.map((t) => {
				const entry = matchingEntry(entries, grepTitle(t));
				const last = t.results.at(-1);
				return {
					title: t.titlePath().filter(Boolean).join(' › '),
					// The gallery's fail step names each blocking failure by file and line, so a red merged
					// job says which test it is red for instead of only that a shard exited 1.
					file: relative(process.cwd(), t.location.file),
					line: t.location.line,
					quarantinedBy: entry?.ticket ?? null,
					expires: entry?.expires ?? null,
					advisory: advisoryReason(last?.annotations ?? t.annotations, advisoryOpts)
				};
			});
		// How many tests passed on a default model. The fail step waves advisory failures through only
		// when the run as a whole got default answers.
		const defaultAnswered = (this.root?.allTests() ?? []).filter(
			(t) =>
				(t.outcome() === 'expected' || t.outcome() === 'flaky') &&
				measuredDefault(t.results.at(-1)?.annotations ?? t.annotations)
		).length;
		try {
			mkdirSync(dirname(QUARANTINE_OUTCOMES), { recursive: true });
			writeFileSync(
				QUARANTINE_OUTCOMES,
				JSON.stringify({ status: result.status, failures, defaultAnswered }, null, 2) + '\n'
			);
		} catch {
			// Best-effort like the other reporters; the gallery step treats a missing file as red.
		}
		for (const f of failures.filter((f) => !f.quarantinedBy && f.advisory)) {
			console.log(
				`::warning::ADVISORY — "${f.title}" failed, ${f.advisory}. It does not block this grade (SOL-277, SOL-367).`
			);
		}
		for (const f of failures.filter((f) => f.quarantinedBy)) {
			console.log(
				`::warning::QUARANTINED — "${f.title}" failed and is quarantined by ${f.quarantinedBy} until ${f.expires}. ` +
					`It does not block this run.`
			);
		}
	}
}
