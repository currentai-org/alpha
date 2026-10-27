import { describe, expect, it } from 'vitest';
import { SHIPPED_BENCHMARKS, languageSupport } from './benchmarks';
import { ImportError, importRuns, mergeRuns, type RunRow } from './importRuns';
import { SHIPPED_LANGUAGE_SCORES, measuredScore, neutralSupport, parseLanguageScores, rescale, type LanguageScores } from './languageScores';

const BELEBELE = {
	name: 'Belebele',
	version: 'rev-a',
	ran: '2026-10-06',
	questions: 900,
	chance: 0.25,
	url: 'https://huggingface.co/datasets/facebook/belebele',
	measures: 'Understanding.',
	doesNotMeasure: 'Writing.'
};

/** Fixture: two models measured in Vietnamese, one in Portuguese. */
const fixture: LanguageScores = {
	version: 1,
	benchmarks: { 'belebele-2026-10-06': BELEBELE },
	scores: {
		'belebele-2026-10-06': {
			'mistral-large': { vie: 0.85, por: 0.9 },
			'apertus-70b': { vie: 0.55 }
		}
	}
};

describe('rescale', () => {
	it('puts guessing at 0, so a 0.3 on four-choice Belebele counts as barely working, not as 0.3', () => {
		expect(rescale(0.25, 0.25)).toBe(0);
		expect(rescale(0.3, 0.25)).toBe(0.07);
		expect(rescale(1, 0.25)).toBe(1);
		expect(rescale(0.1, 0.25)).toBe(0);
	});
});

describe('languageSupport with measured scores', () => {
	it('uses the measured score, rescaled above chance, over the hand-set estimate', () => {
		const s = languageSupport(SHIPPED_BENCHMARKS, 'apertus-70b', 'vie', fixture);
		expect(s).toMatchObject({ via: 'measured', value: rescale(0.55, 0.25) });
		expect(s.measured?.raw).toBe(0.55);
		expect(s.measured?.benchmark.name).toBe('Belebele');
	});

	it('gives an unmeasured model the lowest of the measured ones in that language: unknown, never 0, never its estimate, never above a tested model', () => {
		const s = languageSupport(SHIPPED_BENCHMARKS, 'glm-5.2', 'vie', fixture);
		expect(s.via).toBe('neutral');
		expect(s.value).toBeCloseTo(rescale(0.55, 0.25), 2);
		expect(s.measured).toBeUndefined();
	});

	it('falls back to the hand-set estimates only where nobody was measured in the language', () => {
		expect(languageSupport(SHIPPED_BENCHMARKS, 'bielik-11b', 'pol', fixture).via).toBe('exact');
		expect(neutralSupport(fixture, 'pol')).toBeUndefined();
	});

	it('lets a variety borrow its own model’s measured parent language, discounted', () => {
		const s = languageSupport(SHIPPED_BENCHMARKS, 'mistral-large', 'por-BR', fixture);
		expect(s.via).toBe('parent');
		expect(s.value).toBeLessThan(rescale(0.9, 0.25));
		expect(s.measured?.raw).toBe(0.9);
	});

	it('every shipped score names a benchmark with a source the models page can show', () => {
		for (const id of Object.keys(SHIPPED_LANGUAGE_SCORES.scores)) {
			expect(SHIPPED_LANGUAGE_SCORES.benchmarks[id]?.url, id).toMatch(/^https:/);
		}
	});
});

describe('parseLanguageScores', () => {
	it('refuses a score whose benchmark has no entry, since the models page must name its source', () => {
		expect(() => parseLanguageScores({ version: 1, benchmarks: {}, scores: { x: { 'mistral-large': { vie: 0.5 } } } })).toThrow(
			/no entry under benchmarks/
		);
	});

	it('refuses a null or zero-filled placeholder for an unmeasured pair: unmeasured pairs are left out', () => {
		const bad = structuredClone(fixture) as unknown as { scores: Record<string, Record<string, Record<string, unknown>>> };
		bad.scores['belebele-2026-10-06']['glm-5.2'] = { vie: null };
		expect(() => parseLanguageScores(bad)).toThrow(/leave an unmeasured language out/);
	});
});

const row = (over: Partial<RunRow>): RunRow => ({
	benchmark: 'belebele',
	benchmarkVersion: 'rev-a',
	datasetUrl: 'https://huggingface.co/datasets/facebook/belebele',
	language: 'vie_Latn',
	modelId: 'mistralai/mistral-large-2512',
	promptCondition: 'persona',
	questionsExpected: 900,
	questionsScored: 900,
	accuracy: 0.84,
	status: 'complete',
	finishedAt: '2026-10-06T10:00:00Z',
	...over
});

describe('importRuns', () => {
	it('keeps finished runs only, maps Belebele codes and router model ids to Alpha’s, and names the run', () => {
		const result = importRuns([
			row({}),
			row({ language: 'zho_Hans', accuracy: 0.8 }),
			row({ language: 'yor_Latn', status: 'incomplete', questionsScored: 412, accuracy: 0.3 })
		]);
		const run = result.runs['belebele-2026-10-06'];
		expect(run.scores).toEqual({ 'mistral-large': { vie: 0.84, cmn: 0.8 } });
		expect(run.benchmark).toMatchObject({ name: 'Belebele', chance: 0.25, questions: 900, ran: '2026-10-06' });
		expect(result.skipped.join('\n')).toMatch(/yor_Latn .*: incomplete run/);
	});

	it('refuses rows that mix prompt conditions unless one is chosen', () => {
		const rows = [row({}), row({ promptCondition: 'bare', accuracy: 0.8 })];
		expect(() => importRuns(rows)).toThrow(ImportError);
		expect(importRuns(rows, { prompt: 'bare' }).runs['belebele-2026-10-06'].scores['mistral-large'].vie).toBe(0.8);
	});

	it('fails loudly on a language or model it can’t place, instead of dropping the score', () => {
		expect(() => importRuns([row({ language: 'hin_Latn' })])).toThrow(/no Alpha language tag/);
		expect(() => importRuns([row({ modelId: 'someone/unknown-7b' })])).toThrow(/matches no catalog model/);
	});

	it('lets a re-run supersede the older result for the same pair rather than average with it', () => {
		const first = mergeRuns(fixture, importRuns([row({ language: 'vie_Latn', accuracy: 0.6, finishedAt: '2026-11-01T00:00:00Z' })]));
		expect(measuredScore(first, 'mistral-large', 'vie')?.raw).toBe(0.6);
		expect(measuredScore(first, 'mistral-large', 'vie')?.value).toBe(rescale(0.6, 0.25));
		// Portuguese wasn't re-run, so its older score stays.
		expect(measuredScore(first, 'mistral-large', 'por')?.raw).toBe(0.9);
		expect(() => parseLanguageScores(first)).not.toThrow();
	});
});
