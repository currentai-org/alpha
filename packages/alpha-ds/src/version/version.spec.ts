import { describe, expect, it } from 'vitest';
import {
	extractSurface,
	isVersionedPath,
	loadLedger
} from '../../../../web/scripts/lib/dsLedger.mjs';
import { diffSurface, foldLedger, parseEntry, requiredBump } from './ledger.ts';

const entry = (bump: string, surface = '', extra = '') =>
	`---\nbump: ${bump}\nsummary: s\n${extra}---\n\nnotes\n${surface ? '```surface\n' + surface + '\n```\n' : ''}`;

describe('the changelog vouches for every public name — an unrecorded change fails here', () => {
	it('the surface extracted from the code equals the surface the changelog folds to', async () => {
		const drift = diffSurface(loadLedger().surface, await extractSurface());
		// Red? Run `pnpm ds:change "<summary>"` — it writes exactly these lines into an entry.
		expect(drift).toEqual({ added: [], removed: [] });
	});

	it('extracts every kind of public name, so no kind can drift unnoticed', async () => {
		const kinds = new Set([...(await extractSurface())].map((l) => l.split(' ')[0]));
		expect([...kinds].sort()).toEqual(
			['export', 'part', 'prop', 'rule', 'theme', 'token', 'type', 'utility', 'variant'].sort()
		);
	});
});

describe('version is derived, order-independent and only rises', () => {
	it('counts entries by bump kind', () => {
		const l = foldLedger({
			'2026-01-01-a': entry('major'),
			'2026-01-02-b': entry('minor'),
			'2026-01-03-c': entry('patch'),
			'2026-01-04-d': entry('patch')
		});
		expect(l.version).toBe('1.1.2');
		expect(l.releases.map((r) => r.version)).toEqual(['1.1.2', '1.1.1', '1.1.0', '1.0.0']);
	});

	it('lands on the same version whichever of two branches merges first', () => {
		const a = { '2026-01-01-x': entry('major'), '2026-01-05-late': entry('minor') };
		const b = { '2026-01-03-early': entry('patch') };
		expect(foldLedger({ ...a, ...b }).version).toBe(foldLedger({ ...b, ...a }).version);
		expect(foldLedger({ ...a, ...b }).version).toBe('1.1.1');
	});

	it('folds deltas over the baseline snapshot, removals included', () => {
		const l = foldLedger({
			'2026-01-01-base': entry('minor', '+ export A\n+ export B', 'baseline: true\n'),
			'2026-01-02-drop': entry('major', '- export B\n+ export C')
		});
		expect([...l.surface].sort()).toEqual(['export A', 'export C']);
	});
});

describe('an entry cannot understate its change', () => {
	it('rejects a minor entry whose surface removes a name (removal is breaking)', () => {
		expect(() => parseEntry('2026-01-01-x', entry('minor', '- export Gone'))).toThrow(
			/needs major/
		);
	});
	it('rejects a patch entry whose surface adds a name', () => {
		expect(() => parseEntry('2026-01-01-x', entry('patch', '+ export New'))).toThrow(/needs minor/);
	});
	it('rejects an unknown bump, a missing summary and a badly named file', () => {
		expect(() => parseEntry('2026-01-01-x', entry('huge'))).toThrow(/bump must be/);
		expect(() => parseEntry('2026-01-01-x', '---\nbump: patch\n---\n')).toThrow(/summary/);
		expect(() => parseEntry('no-date', entry('patch'))).toThrow(/YYYY-MM-DD/);
	});
	it('requiredBump: removal → major, addition → minor, neither → patch', () => {
		expect(requiredBump({ added: ['a'], removed: ['b'] })).toBe('major');
		expect(requiredBump({ added: ['a'], removed: [] })).toBe('minor');
		expect(requiredBump({ added: [], removed: [] })).toBe('patch');
	});
});

describe('which files count as a design-system change', () => {
	it.each([
		['packages/alpha-ds/src/components/kbd/Kbd.svelte', true],
		['packages/alpha-ds/src/tokens/scales.ts', true],
		['web/eslint-rules/alpha-ds/rules/no-raw-colors.js', true],
		['packages/alpha-ds/src/components/kbd/kbd.docs.ts', false],
		['packages/alpha-ds/src/components/kbd/examples/Basic.svelte', false],
		['packages/alpha-ds/src/catalog/ui/DocsShell.svelte', false],
		['packages/alpha-ds/src/changelog/2026-01-01-x.md', false],
		['packages/alpha-ds/src/tokens/tokens.spec.ts', false],
		['web/src/lib/chat/components/ChatWindow.svelte', false]
	])('%s → %s', (path, expected) => {
		expect(isVersionedPath(path)).toBe(expected);
	});
});
