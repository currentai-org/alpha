// When a feature works in one environment and is broken in another, the tempting fix is a matcher
// weak enough to pass in both, which leaves a test that cannot go red for the defect it was written
// about (CUR-1615: F6's provenance assertion, weakened until preview's missing headers passed). The
// sanctioned move is `test.fail()` in the broken environment only: Playwright turns it red the day
// the feature starts working there, so the cell retires itself.
//
// known-broken.json is the matrix of those cells. Each one names a test, the environment it is
// broken in, the ticket that owns the fix and a date the entry stops working. Specs read it through
// failWhereKnownBroken(); scripts/check-known-broken.mjs keeps it honest in pre-push and CI.
//
// Distinct from quarantine.json (CUR-2445), which takes a flaky test out of the PR gate. A
// known-broken test stays in every run and is expected to fail where its cell says.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const KNOWN_BROKEN_FILE = join(HERE, 'known-broken.json');
export const SCENARIOS_DIR = join(HERE, 'scenarios');

const TARGETS = ['local', 'preview', 'develop', 'production'];

/** Same ceiling as a quarantine entry: long enough to fix inside a cycle, short enough that a cell
 *  nobody is working on comes back as a red check. */
const MAX_DAYS = 21;

/**
 * @typedef {{ spec: string, title: string, target: string, ticket: string, expires: string, reason: string }} KnownBrokenCell
 */

/** @returns {KnownBrokenCell[]} */
export function readKnownBroken(file = KNOWN_BROKEN_FILE) {
	const parsed = JSON.parse(readFileSync(file, 'utf8'));
	if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of cells`);
	return parsed;
}

/** Which environment a scenario run targets, from SCENARIO_BASE_URL. */
export function scenarioTarget(baseUrl) {
	if (!baseUrl) return 'local';
	const host = new URL(baseUrl).hostname;
	if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return 'local';
	if (host === 'www.aipotluck.org' || host === 'aipotluck.org' || host === 'alpha.aipotluck.org')
		return 'production';
	if (host === 'develop.aipotluck.org') return 'develop';
	return 'preview';
}

/** The cell covering this test in this environment, or undefined. */
export function cellFor(cells, { spec, title, target }) {
	return cells.find((c) => c.spec === spec && c.title === title && c.target === target);
}

/**
 * Marks the running test as expected to fail when known-broken.json has a cell for it here. Call it
 * first in the test body, passing Playwright's `test`.
 * @param {{ info: () => { file: string, title: string }, fail: (condition: boolean, description: string) => void }} test
 */
export function failWhereKnownBroken(
	test,
	{ cells = readKnownBroken(), baseUrl = process.env.SCENARIO_BASE_URL } = {}
) {
	const { file, title } = test.info();
	const cell = cellFor(cells, { spec: basename(file), title, target: scenarioTarget(baseUrl) });
	if (cell)
		test.fail(
			true,
			`${cell.ticket}, known broken on ${cell.target} until ${cell.expires}: ${cell.reason}`
		);
	return cell;
}

/** 'YYYY-MM-DD' for a Date, in UTC, so the check reads the same on a runner and a laptop. */
export const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * Every reason the matrix is unusable. An empty array means valid.
 * @param {unknown[]} cells
 * @param {{ today: string, specSource: (spec: string) => string | null }} ctx  specSource returns
 *   the spec file's text, or null when there is no such file.
 */
export function knownBrokenProblems(cells, { today, specSource }) {
	const problems = [];
	const latest = isoDay(new Date(Date.parse(today) + MAX_DAYS * 86_400_000));
	cells.forEach((raw, i) => {
		const c = /** @type {Record<string, unknown>} */ (raw ?? {});
		const at = `cell ${i}${typeof c.spec === 'string' ? ` (${c.spec})` : ''}`;
		const src =
			typeof c.spec === 'string' && c.spec.endsWith('.spec.ts') ? specSource(c.spec) : null;
		if (typeof c.spec !== 'string' || !c.spec.endsWith('.spec.ts')) {
			problems.push(`${at}: "spec" must be a .spec.ts file name under e2e/scenarios`);
		} else if (src === null) {
			problems.push(`${at}: no such spec under e2e/scenarios`);
		} else if (!src.includes('failWhereKnownBroken(')) {
			problems.push(
				`${at}: ${c.spec} never calls failWhereKnownBroken(), so this cell marks nothing`
			);
		}
		if (typeof c.title !== 'string' || c.title === '') {
			problems.push(`${at}: "title" must be the test's exact title`);
		} else if (src !== null && !src.includes(c.title)) {
			problems.push(`${at}: no test titled "${c.title}" in ${c.spec}`);
		}
		if (typeof c.target !== 'string' || !TARGETS.includes(c.target)) {
			problems.push(`${at}: "target" must be one of ${TARGETS.join(', ')}`);
		}
		if (typeof c.ticket !== 'string' || !/^(?:CUR|SOL)-\d+$/.test(c.ticket)) {
			problems.push(
				`${at}: "ticket" must name the ticket that owns the fix, as CUR-NNN or SOL-NNN`
			);
		}
		if (typeof c.reason !== 'string' || c.reason.trim() === '') {
			problems.push(`${at}: "reason" must say what is broken there`);
		}
		if (
			typeof c.expires !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}$/.test(c.expires) ||
			Number.isNaN(Date.parse(c.expires))
		) {
			problems.push(`${at}: "expires" must be a YYYY-MM-DD date`);
		} else if (c.expires < today) {
			problems.push(
				`${at}: expired on ${c.expires}; fix it and delete the cell, or extend it with a reason on ${c.ticket}`
			);
		} else if (c.expires > latest) {
			problems.push(
				`${at}: expires ${c.expires}, more than ${MAX_DAYS} days out (latest allowed today is ${latest})`
			);
		}
	});
	return problems;
}

/**
 * A `test.fail(` written straight into a spec carries no ticket and no expiry, so nothing ever asks
 * whether it still applies. Returns `file:line` for each one. Specs mark a known-broken cell through
 * failWhereKnownBroken() instead.
 * @param {{ file: string, source: string }[]} specs
 */
export function rawTestFails(specs) {
	const found = [];
	for (const { file, source } of specs) {
		source.split('\n').forEach((line, i) => {
			if (/^\s*\/\//.test(line)) return;
			if (/\btest\.fail\(/.test(line)) found.push(`${file}:${i + 1}`);
		});
	}
	return found;
}
