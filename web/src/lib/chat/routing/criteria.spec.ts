import { describe, expect, it } from 'vitest';
import { SHIPPED_BENCHMARKS, parseBenchmarkTable, skillScoreOf, type BenchmarkTable } from './benchmarks';
import type { DraftAnalysis } from './classifier';
import { criteriaFor, fullShares, sharesFor } from './criteria';
import { DEFAULT_ROUTING, route } from './router';

const SERVED = ['swiss-ai/apertus-v1.5-70b', 'mistral-medium-2604'];

const draft = (lang: string, conf: number, code = 0): DraftAnalysis => ({
	language: { value: lang, confidence: conf, alternatives: [], signal: 'words' },
	difficulty: { value: 'M', confidence: 0.8 },
	skills: code ? [{ id: 'code', confidence: code, reason: 'Has code' }] : [],
	source: 'manual'
});

/** The shipped table plus a coding benchmark on which Apertus beats Mistral. */
function withCodeBenchmark(): BenchmarkTable {
	const t = structuredClone(SHIPPED_BENCHMARKS);
	t.models['apertus-70b'].skills = { code: 0.95 };
	t.models['mistral-medium'].skills = { code: 0.2 };
	return t;
}

describe('routing criteria and weights', () => {
	it('gives language 70% at full confidence by default, less as detection gets unsure, and none when unclear', () => {
		const criteria = criteriaFor(SHIPPED_BENCHMARKS);
		expect(criteria.map((c) => c.id)).toEqual(['language', 'intelligence']);
		expect(fullShares(criteria, DEFAULT_ROUTING.weights)).toEqual({ language: 0.7, intelligence: 0.3 });
		const sure = sharesFor(criteria, draft('fra', 1), DEFAULT_ROUTING.weights);
		const unsure = sharesFor(criteria, draft('fra', 0.3), DEFAULT_ROUTING.weights);
		expect(sure.language).toBeCloseTo(0.7);
		expect(unsure.language!).toBeLessThan(sure.language!);
		expect(sharesFor(criteria, draft('und', 0), DEFAULT_ROUTING.weights)).toMatchObject({ language: 0, intelligence: 1 });
	});

	it('lets a language weight of 0 take language out of the decision', () => {
		const amharic = draft('amh', 0.95);
		expect(route(amharic, SERVED)!.model.id).toBe('apertus-70b');
		const config = { ...DEFAULT_ROUTING, weights: { ...DEFAULT_ROUTING.weights, language: 0 } };
		expect(route(amharic, SERVED, { config })!.model.id).toBe('mistral-medium');
	});

	it('turns a skill scored in the benchmark table into a criterion that counts only on drafts needing the skill', () => {
		const benchmarks = withCodeBenchmark();
		expect(criteriaFor(benchmarks).map((c) => c.id)).toEqual(['language', 'intelligence', 'skill:code']);
		expect(route(draft('eng', 0.9), SERVED, { benchmarks })!.model.id).toBe('mistral-medium');
		const codeDraft = route(draft('eng', 0.9, 0.9), SERVED, { benchmarks })!;
		expect(codeDraft.model.id).toBe('apertus-70b');
		expect(codeDraft.shares['skill:code']).toBeGreaterThan(0);
		expect(Object.values(codeDraft.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
	});

	it('scores a model the skill benchmark did not cover at the median of those it did', () => {
		const t = withCodeBenchmark();
		t.models['alia-40b'].skills = { code: 0.5 };
		expect(skillScoreOf(t, 'bielik-11b', 'code')).toBe(0.5);
		expect(skillScoreOf(t, 'apertus-70b', 'code')).toBe(0.95);
	});

	it('rejects a skill name the classifier does not know, so a typo cannot add a dead criterion', () => {
		const raw = JSON.parse(JSON.stringify(SHIPPED_BENCHMARKS));
		raw.models['apertus-70b'].skills = { coding: 0.9 };
		expect(() => parseBenchmarkTable(raw)).toThrow(/coding is not a known skill/);
	});
});
