// A scenario that fails at random had two ways to stop blocking merges: merge past red or an
// in-spec skip, which the spec-isolation gate refuses and which nobody comes back for.
// quarantine.json is the third way, and it carries the two things the others lack: the ticket that
// owns the fix and a date the entry stops working (CUR-2445).
//
// One module, read by three places: playwright.config.ts (leaves quarantined tests out of a PR's
// gating run), reporters/quarantineOutcomes.ts (marks which of develop's failures were quarantined)
// and scripts/check-scenario-quarantine.mjs (the static check in pre-push and CI).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const QUARANTINE_FILE = join(HERE, 'quarantine.json');
export const SCENARIOS_DIR = join(HERE, 'scenarios');

/** The longest an entry may run. Long enough to fix a flake inside a cycle, short enough that an
 *  entry nobody is working on comes back as a red check instead of a permanent hole. */
const MAX_QUARANTINE_DAYS = 21;

/** How long a lapsed entry only warns on a change that doesn't touch the file. After that it fails
 *  every run again, so a skip nobody extends or lifts can't outlive its cap by more than this. */
export const EXPIRY_GRACE_DAYS = 3;

/**
 * @typedef {{ spec: string, title?: string, ticket: string, expires: string, reason?: string }} QuarantineEntry
 */

/** @returns {QuarantineEntry[]} */
export function readQuarantine(file = QUARANTINE_FILE) {
	const parsed = JSON.parse(readFileSync(file, 'utf8'));
	if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of entries`);
	return parsed;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Playwright matches grep and grepInvert against the suite path joined by spaces: the root (empty),
 * the project name, the file path relative to testDir, describe titles, the test title and its tags,
 * e.g. " chromium data-portability.spec.ts Forget everything… @A3". The file sits between spaces, never
 * at the start, so an entry anchors on whitespace either side of it; one naming a title also needs that
 * text after the file.
 * An entry writes a nested test as "describe › test", the way Playwright prints it; the grep title
 * joins the same parts with a space, so the separator is matched as one.
 * @param {QuarantineEntry} entry
 */
export function entryPattern(entry) {
	const spec = escape(entry.spec);
	const title = entry.title && escape(entry.title.replaceAll(' › ', ' '));
	return new RegExp(title ? `(?:^|\\s)${spec}\\s.*${title}` : `(?:^|\\s)${spec}\\s`);
}

/** @param {QuarantineEntry[]} entries @param {string} grepTitle */
export function matchingEntry(entries, grepTitle) {
	return entries.find((e) => entryPattern(e).test(grepTitle));
}

/** 'YYYY-MM-DD' for a Date, in UTC, so the check reads the same on a runner and a laptop. */
export const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * Every reason the file is unusable. An empty array means valid.
 * @param {unknown[]} entries
 * @param {{ today: string, specExists: (spec: string) => boolean }} ctx
 */
export function quarantineProblems(entries, ctx) {
	return quarantineFindings(entries, ctx).map((f) => f.message);
}

/**
 * Splits the problems into what fails the check and what only warns. For EXPIRY_GRACE_DAYS after its
 * expiry, a lapsed entry fails only a change that touches quarantine.json: it still keeps its test out
 * of the PR run (playwright.config.ts reads every entry), so failing every other PR on that date
 * punished whoever happened to be open for an extension only the entry's owner can write (SOL-224).
 * Past the grace it fails everywhere, so the skip can't become permanent. Every other problem fails
 * everywhere.
 * @param {unknown[]} entries
 * @param {{ today: string, specExists: (spec: string) => boolean, touchesQuarantine: boolean }} ctx
 */
export function quarantineVerdict(entries, { touchesQuarantine, ...ctx }) {
	const errors = [];
	const warnings = [];
	for (const f of quarantineFindings(entries, ctx)) {
		(f.expired && !touchesQuarantine ? warnings : errors).push(f.message);
	}
	return { errors, warnings };
}

/**
 * @param {unknown[]} entries
 * @param {{ today: string, specExists: (spec: string) => boolean }} ctx
 * @returns {{ message: string, expired: boolean }[]}
 */
function quarantineFindings(entries, { today, specExists }) {
	/** @type {{ message: string, expired: boolean }[]} */
	const findings = [];
	const problems = { push: (message, expired = false) => findings.push({ message, expired }) };
	const latest = isoDay(new Date(Date.parse(today) + MAX_QUARANTINE_DAYS * 86_400_000));
	entries.forEach((raw, i) => {
		const e = /** @type {Record<string, unknown>} */ (raw ?? {});
		const at = `entry ${i}${typeof e.spec === 'string' ? ` (${e.spec})` : ''}`;
		if (typeof e.spec !== 'string' || !e.spec.endsWith('.spec.ts')) {
			problems.push(`${at}: "spec" must be a .spec.ts path relative to e2e/scenarios`);
		} else if (!specExists(e.spec)) {
			problems.push(`${at}: no such spec under e2e/scenarios`);
		}
		if (typeof e.ticket !== 'string' || !/^(?:CUR|SOL)-\d+$/.test(e.ticket)) {
			problems.push(
				`${at}: "ticket" must name the ticket that owns the fix, as CUR-NNN or SOL-NNN`
			);
		}
		if (
			typeof e.expires !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) ||
			Number.isNaN(Date.parse(e.expires))
		) {
			problems.push(`${at}: "expires" must be a YYYY-MM-DD date`);
		} else if (e.expires < today) {
			const cutoff = isoDay(new Date(Date.parse(e.expires) + EXPIRY_GRACE_DAYS * 86_400_000));
			const graced = today <= cutoff;
			problems.push(
				`${at}: expired on ${e.expires}; fix the spec and delete the entry, or extend it with a reason on ${e.ticket}` +
					(graced ? `. Fails every PR after ${cutoff}` : ''),
				graced
			);
		} else if (e.expires > latest) {
			problems.push(
				`${at}: expires ${e.expires}, more than ${MAX_QUARANTINE_DAYS} days out (latest allowed today is ${latest})`
			);
		}
		if (e.title !== undefined && (typeof e.title !== 'string' || e.title === '')) {
			problems.push(`${at}: "title" is optional, but when present must be a non-empty string`);
		}
	});
	return findings;
}
