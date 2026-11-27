import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '@aipotluck/alpha-ds';
import { catalog, type CatalogModel } from './catalog';
import { SHIPPED_LANGUAGE_SCORES, type LanguageBenchmark, type LanguageScores } from './languageScores';
import { LAUNCH_LANGUAGES } from '../languageData';
import { wwwPickerCatalog } from './wwwPicker';
import {
	BORROWED,
	MIN_QUESTIONS_TO_COMPARE,
	cellFor,
	languageBoard,
	latestRun,
	modelBoard,
	openingLanguage,
	ownLanguageName,
	languagePickerItems,
	percent,
	wilson95
} from './leaderboard';

const model = (id: string) => catalog.find((m) => m.id === id) as CatalogModel;
const bench = (ran: string, questions: number): LanguageBenchmark => ({
	name: 'Belebele',
	version: 'rev-a',
	ran,
	questions,
	chance: 0.25,
	url: 'https://huggingface.co/datasets/facebook/belebele',
	measures: 'Understanding.',
	doesNotMeasure: 'Writing.'
});

const apertus = model('apertus-70b');
const seaLion = model('sea-lion-nemotron-120b');
const bielik = model('bielik-11b');
const large4 = model('mistral-large-4');
const medium = model('mistral-medium');
const alia = model('alia-40b');

describe('wilson95', () => {
	it('gives about ±3.5 points at 300 questions and 90%, and over ±10 at 20 questions', () => {
		const r300 = wilson95(0.9, 300);
		expect(r300.high - r300.low).toBeGreaterThan(0.06);
		expect(r300.high - r300.low).toBeLessThan(0.075);
		const r20 = wilson95(0.95, 20);
		expect(r20.high - r20.low).toBeGreaterThan(0.2);
	});
	it('stays inside 0–1 at a perfect score', () => {
		const r = wilson95(1, 33);
		expect(r.high).toBe(1);
		expect(r.low).toBeLessThan(1);
	});
	it('throws on an empty sample rather than returning a range', () => {
		expect(() => wilson95(0.5, 0)).toThrow();
	});
});

describe('cellFor', () => {
	it('shows the most recent run and never averages two runs of the same pair', () => {
		const data: LanguageScores = {
			version: 1,
			benchmarks: { old: bench('2026-10-01', 900), new: bench('2026-10-20', 300) },
			scores: { old: { 'apertus-70b': { por: 0.6 } }, new: { 'apertus-70b': { por: 0.9 } } }
		};
		const c = cellFor(data, apertus, 'por');
		expect(c.accuracy).toBe(0.9);
		expect(c.benchmarkId).toBe('new');
		expect(c.questions).toBe(300);
	});
	it('breaks a same-day tie with the larger sample', () => {
		const data: LanguageScores = {
			version: 1,
			benchmarks: { small: bench('2026-10-20', 300), full: bench('2026-10-20', 900) },
			scores: { small: { 'apertus-70b': { por: 0.6 } }, full: { 'apertus-70b': { por: 0.8 } } }
		};
		expect(cellFor(data, apertus, 'por').benchmarkId).toBe('full');
	});
	it('reads a pair nobody measured as not measured, with no accuracy at all (never 0)', () => {
		const data: LanguageScores = { version: 1, benchmarks: {}, scores: {} };
		const c = cellFor(data, alia, 'cat');
		expect(c.status).toBe('not-measured');
		expect(c.accuracy).toBeUndefined();
	});
	it(`keeps a score on fewer than ${MIN_QUESTIONS_TO_COMPARE} questions out of the comparison`, () => {
		const data: LanguageScores = {
			version: 1,
			benchmarks: { b: bench('2026-10-26', 17) },
			scores: { b: { 'mistral-large-4': { cat: 0.94 } } }
		};
		const c = cellFor(data, large4, 'cat');
		expect(c.status).toBe('too-few');
		expect(c.partial).toBe(true);
	});
	it('does not show a borrowed score as the borrowing model’s own', () => {
		const id = `${BORROWED[0].benchmarkPrefix}cat`;
		const data: LanguageScores = {
			version: 1,
			benchmarks: { [id]: bench('2026-10-26', 17) },
			scores: { [id]: { 'mistral-large-4': { cat: 0.94 }, 'mistral-medium': { cat: 0.94 } } }
		};
		expect(cellFor(data, medium, 'cat').status).toBe('not-measured');
		expect(cellFor(data, large4, 'cat').accuracy).toBe(0.94);
	});
});

describe('languageBoard', () => {
	const data: LanguageScores = {
		version: 1,
		benchmarks: { a: bench('2026-10-27', 300), b: bench('2026-10-27', 650), few: bench('2026-10-26', 20) },
		scores: {
			a: { 'sea-lion-nemotron-120b': { hau: 0.86 }, 'bielik-11b': { hau: 0.28, swh: 0.9 } },
			b: { 'apertus-70b': { hau: 0.48, swh: 0.89 } },
			few: { 'mistral-large-4': { hau: 0.95, swh: 0.95 } }
		}
	};
	const models = [alia, apertus, bielik, seaLion, large4];

	it('orders compared scores first, then too-few, then not measured, and never puts a small sample on top', () => {
		const board = languageBoard(data, models, 'hau');
		expect(board.map((c) => [c.model.id, c.status])).toEqual([
			['sea-lion-nemotron-120b', 'compared'],
			['apertus-70b', 'compared'],
			['bielik-11b', 'compared'],
			['mistral-large-4', 'too-few'],
			['alia-40b', 'not-measured']
		]);
	});
	it('marks nothing close to the top when the highest score is clearly separated from the rest', () => {
		const board = languageBoard(data, models, 'hau');
		expect(board.some((c) => c.closeToTop)).toBe(false);
	});
	it('marks scores whose ranges overlap the highest as close to the top, the highest included', () => {
		const board = languageBoard(data, models, 'swh');
		expect(board.filter((c) => c.closeToTop).map((c) => c.model.id)).toEqual(['bielik-11b', 'apertus-70b']);
	});
	it('marks nothing close to the top when only one model can be compared', () => {
		const one: LanguageScores = { version: 1, benchmarks: { a: bench('2026-10-27', 300) }, scores: { a: { 'sea-lion-nemotron-120b': { yor: 0.7 } } } };
		expect(languageBoard(one, models, 'yor').some((c) => c.closeToTop)).toBe(false);
	});
});

describe('modelBoard', () => {
	it('lists every language, measured ones by score and the rest as not measured', () => {
		const data: LanguageScores = {
			version: 1,
			benchmarks: { a: bench('2026-10-27', 300) },
			scores: { a: { 'sea-lion-nemotron-120b': { hau: 0.86, cmn: 0.92 } } }
		};
		const board = modelBoard(data, seaLion, ['hau', 'cmn', 'yor', 'amh'], (t) => t);
		expect(board.map((c) => [c.language, c.status])).toEqual([
			['cmn', 'compared'],
			['hau', 'compared'],
			['amh', 'not-measured'],
			['yor', 'not-measured']
		]);
	});
});

describe('the shipped scores, as the leaderboard reads them', () => {
	const served = wwwPickerCatalog;

	it('shows Mistral Medium only where it was measured itself, never with Large 4’s borrowed scores', () => {
		const measured = LAUNCH_LANGUAGES.filter((l) => cellFor(SHIPPED_LANGUAGE_SCORES, medium, l).status !== 'not-measured');
		for (const l of measured) {
			const c = cellFor(SHIPPED_LANGUAGE_SCORES, medium, l);
			expect(BORROWED.some((b) => c.benchmarkId!.startsWith(b.benchmarkPrefix))).toBe(false);
		}
	});
	it('every score listed as borrowed equals the measured model’s score in the same entry, where both appear', () => {
		for (const b of BORROWED) {
			for (const [id, byModel] of Object.entries(SHIPPED_LANGUAGE_SCORES.scores)) {
				if (!id.startsWith(b.benchmarkPrefix)) continue;
				const own = byModel[b.measuredModel] ?? {};
				for (const [tag, v] of Object.entries(byModel[b.model] ?? {})) {
					if (tag in own) expect(v).toBe(own[tag]);
				}
			}
		}
	});
	it('shows ALIA as not measured in every launch language rather than as 0', () => {
		for (const l of LAUNCH_LANGUAGES) expect(cellFor(SHIPPED_LANGUAGE_SCORES, alia, l).status).toBe('not-measured');
	});
	it('every compared score rests on at least the minimum number of questions', () => {
		for (const l of LAUNCH_LANGUAGES) {
			for (const c of languageBoard(SHIPPED_LANGUAGE_SCORES, served, l)) {
				if (c.status === 'compared') expect(c.questions!).toBeGreaterThanOrEqual(MIN_QUESTIONS_TO_COMPARE);
			}
		}
	});
	it('dates the page from the latest run behind a shown score', () => {
		expect(latestRun(SHIPPED_LANGUAGE_SCORES, served, LAUNCH_LANGUAGES)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('percent', () => {
	it('rounds to whole points, the precision a few hundred questions support', () => {
		expect(percent(0.937)).toBe('94%');
		expect(percent(0.25)).toBe('25%');
	});
});

describe('openingLanguage', () => {
	const langs = ['eng', 'spa', 'por', 'cmn'];
	it('opens on the first browser language that is a launch language', () => {
		expect(openingLanguage('fr-FR,pt-BR;q=0.8,en;q=0.5', langs)).toBe('por');
		expect(openingLanguage('zh-CN', langs)).toBe('cmn');
	});
	it('falls back to Spanish when the browser names none of them, or nothing', () => {
		expect(openingLanguage('ja', langs)).toBe('spa');
		expect(openingLanguage(null, langs)).toBe('spa');
	});
});

describe('the language picker', () => {
	it('names each language in its own language too, never repeating the English name', () => {
		expect(ownLanguageName('cat')).toBe('català');
		expect(ownLanguageName('arb')).toBe('العربية');
		expect(ownLanguageName('eng')).toBeUndefined();
		expect(ownLanguageName('tgl')).toBeUndefined();
	});
	it('finds a language by its English name, its own name, or a typo, without accents', () => {
		const items = languagePickerItems(LAUNCH_LANGUAGES);
		expect(fuzzyFilter(items, 'portugues')[0]?.value).toBe('por');
		expect(fuzzyFilter(items, 'català')[0]?.value).toBe('cat');
		expect(fuzzyFilter(items, 'ctln')[0]?.value).toBe('cat');
		expect(fuzzyFilter(items, 'Kiswahili')[0]?.value).toBe('swh');
	});
});
