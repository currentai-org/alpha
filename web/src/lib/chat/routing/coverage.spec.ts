import { describe, expect, it } from 'vitest';
import { languageCoverage, specialists } from './coverage';
import { languageName } from './languages';
import { LAUNCH_LANGUAGES } from '../languageData';
import { DEFAULT_ROUTING, route } from './router';
import { PICKER } from '../../../../config/picker';
import type { DraftAnalysis } from './classifier';

const served = [...PICKER.production];
const coverageOf = (ids = served, opts: Parameters<typeof languageCoverage>[1] = {}) =>
	languageCoverage(ids, opts, languageName, LAUNCH_LANGUAGES);

const medium = (tag: string): DraftAnalysis => ({
	language: { value: tag, confidence: 1, alternatives: [], signal: 'words' },
	difficulty: { value: 'M', confidence: 1 },
	skills: [],
	source: 'manual'
});

describe('languageCoverage: the Languages panel names Auto’s medium-size pick per launch language (CUR-4692)', () => {
	const { strong, learning } = coverageOf();
	const all = [...strong, ...learning];

	it('names, for every launch language, the model route() would send a medium-size draft in that language to', () => {
		expect(all.map((l) => l.tag).sort()).toEqual([...LAUNCH_LANGUAGES].sort());
		for (const lang of all) {
			expect(lang.model.id, lang.tag).toBe(route(medium(lang.tag), served)?.model.id);
		}
	});

	it('does not name GLM for Pashto, or Apertus for English, and names GLM for Chinese', () => {
		expect(all.find((l) => l.tag === 'pbt')?.model.id).not.toBe('glm-5.2');
		expect(all.find((l) => l.tag === 'eng')?.model.id).not.toBe('apertus-70b');
		expect(all.find((l) => l.tag === 'cmn')?.model.id).toBe('glm-5.2');
	});

	it('files a language as still-learning by Auto’s best choosable support, the same figure as the gap pill', () => {
		for (const lang of all) {
			const choice = route(medium(lang.tag), served);
			const choosable = (choice?.scores ?? []).filter((s) => s.available && s.benchmarked);
			const best = Math.max(...choosable.map((s) => s.language));
			expect(lang.support).toBe(best);
			expect(lang.support >= DEFAULT_ROUTING.weakSupport).toBe(strong.some((l) => l.tag === lang.tag));
		}
	});

	it('names every launch language in words, never a bare code', () => {
		for (const l of all) expect(l.name).not.toMatch(/^[A-Z]{3}$/);
	});

	it('returns nothing (no claim of coverage) when no model is served', () => {
		expect(coverageOf([])).toEqual({ strong: [], learning: [] });
	});

	it('stops naming a busy model Auto would skip: Chinese names GLM, and not GLM once GLM is busy', () => {
		expect(all.find((l) => l.tag === 'cmn')?.model.id).toBe('glm-5.2');
		const skipped = coverageOf(served, { busy: ['zai-org/GLM-5.2'] });
		expect([...skipped.strong, ...skipped.learning].find((l) => l.tag === 'cmn')?.model.id).not.toBe('glm-5.2');
	});
});

describe('specialists: the Languages panel shares the well-handled languages out by the model Auto picks for them', () => {
	const { strong } = coverageOf();
	const { byModel, cycle } = specialists(strong);

	it('counts every well-handled language once, against Auto’s pick for it, most first', () => {
		expect(byModel.reduce((n, g) => n + g.count, 0)).toBe(strong.length);
		for (const g of byModel) expect(g.count).toBe(strong.filter((l) => l.model.id === g.model.id).length);
		expect(byModel.map((g) => g.count)).toEqual([...byModel.map((g) => g.count)].sort((a, b) => b - a));
	});

	it('cycles through every well-handled language, taking turns across the models before repeating one', () => {
		expect(cycle.map((l) => l.tag).sort()).toEqual(strong.map((l) => l.tag).sort());
		const firstRound = cycle.slice(0, byModel.length).map((l) => l.model.id);
		expect(new Set(firstRound).size).toBe(byModel.length);
	});

	it('returns nothing to show for no languages', () => {
		expect(specialists([])).toEqual({ byModel: [], cycle: [] });
	});
});
