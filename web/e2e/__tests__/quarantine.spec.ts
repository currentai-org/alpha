import { describe, expect, it } from 'vitest';
import {
	entryPattern,
	matchingEntry,
	quarantineProblems,
	quarantineVerdict
} from '../quarantine.mjs';

// The string Playwright builds for grep/grepInvert: root suite (''), project, file, test title, tags.
// Read from playwright's _grepTitleWithTags.
const grepTitle = (file: string, title: string, tags = '@A3') =>
	` chromium ${file} ${title} ${tags}`;

const entry = { spec: 'data-portability.spec.ts', ticket: 'CUR-2445', expires: '2026-10-10' };

describe('quarantine entry patterns', () => {
	it('match every test in the named spec file, wherever the file sits in the grep title', () => {
		expect(entryPattern(entry).test(grepTitle('data-portability.spec.ts', 'anything'))).toBe(true);
	});

	it('do not match a different file whose name merely ends the same way', () => {
		expect(entryPattern(entry).test(grepTitle('legacy-data-portability.spec.ts', 'anything'))).toBe(
			false
		);
	});

	it('narrow to one test when the entry names a title', () => {
		const titled = { ...entry, title: 'deleting the account' };
		expect(
			entryPattern(titled).test(
				grepTitle('data-portability.spec.ts', 'deleting the account deletes it')
			)
		).toBe(true);
		expect(
			entryPattern(titled).test(
				grepTitle('data-portability.spec.ts', 'an anonymous visitor can delete')
			)
		).toBe(false);
	});

	it('match a test inside a describe, written "describe › test" as quarantine-develop-reds files it', () => {
		const nested = {
			...entry,
			spec: 'dataset-layout.spec.ts',
			title: 'dataset layout, desktop › a header click sorts every table'
		};
		expect(
			entryPattern(nested).test(
				grepTitle(
					'dataset-layout.spec.ts',
					'dataset layout, desktop a header click sorts every table, flips on a second click'
				)
			)
		).toBe(true);
	});

	it('treat regex characters in a title literally', () => {
		const titled = { ...entry, title: 'Forget everything (all of it)' };
		expect(
			matchingEntry(
				[titled],
				grepTitle('data-portability.spec.ts', 'Forget everything (all of it) works')
			)
		).toBe(titled);
	});
});

describe('quarantine validation fails loud on an untracked or lapsed entry', () => {
	const ctx = { today: '2026-10-01', specExists: () => true };

	it('accepts an owned entry that expires within the cap', () => {
		expect(quarantineProblems([entry], ctx)).toEqual([]);
	});

	it('refuses an entry whose expiry has passed', () => {
		expect(quarantineProblems([{ ...entry, expires: '2026-09-30' }], ctx).join()).toMatch(
			/expired on 2026-09-30/
		);
	});

	it('accepts an entry on its last day', () => {
		expect(quarantineProblems([{ ...entry, expires: '2026-10-01' }], ctx)).toEqual([]);
	});

	it('refuses an entry with no owner ticket', () => {
		const { ticket: _ticket, ...noTicket } = entry;
		expect(quarantineProblems([noTicket], ctx).join()).toMatch(/"ticket" must name/);
	});

	it('accepts a SOL owner ticket and still refuses a malformed one', () => {
		expect(quarantineProblems([{ ...entry, ticket: 'SOL-4' }], ctx)).toEqual([]);
		expect(quarantineProblems([{ ...entry, ticket: 'SOL4' }], ctx).join()).toMatch(
			/"ticket" must name/
		);
	});

	it('refuses an expiry more than 21 days out', () => {
		expect(quarantineProblems([{ ...entry, expires: '2026-10-23' }], ctx).join()).toMatch(
			/more than 21 days out/
		);
		expect(quarantineProblems([{ ...entry, expires: '2026-10-22' }], ctx)).toEqual([]);
	});

	it('refuses an entry naming a spec that does not exist', () => {
		expect(quarantineProblems([entry], { ...ctx, specExists: () => false }).join()).toMatch(
			/no such spec/
		);
	});
});

describe('an expired entry fails only a change to quarantine.json, and warns on every other PR', () => {
	const ctx = { today: '2026-10-01', specExists: () => true };
	const expired = { ...entry, expires: '2026-09-30' };

	it('fails a change that touches quarantine.json', () => {
		const { errors, warnings } = quarantineVerdict([expired], { ...ctx, touchesQuarantine: true });
		expect(errors.join()).toMatch(/expired on 2026-09-30/);
		expect(warnings).toEqual([]);
	});

	it('only warns on a change that does not touch it', () => {
		const { errors, warnings } = quarantineVerdict([expired], { ...ctx, touchesQuarantine: false });
		expect(errors).toEqual([]);
		expect(warnings.join()).toMatch(/expired on 2026-09-30/);
	});

	it('fails every change once the entry is past its grace days, so the skip cannot stay forever', () => {
		const lapsed = { ...entry, expires: '2026-09-27' };
		const lastWarn = quarantineVerdict([{ ...entry, expires: '2026-09-28' }], {
			...ctx,
			touchesQuarantine: false
		});
		expect(lastWarn.errors).toEqual([]);
		expect(lastWarn.warnings.join()).toMatch(/Fails every PR after 2026-10-01/);
		const { errors } = quarantineVerdict([lapsed], { ...ctx, touchesQuarantine: false });
		expect(errors.join()).toMatch(/expired on 2026-09-27/);
	});

	it('still fails an unowned entry on a change that does not touch it', () => {
		const { ticket: _ticket, ...noTicket } = expired;
		const { errors } = quarantineVerdict([noTicket], { ...ctx, touchesQuarantine: false });
		expect(errors.join()).toMatch(/"ticket" must name/);
	});
});
