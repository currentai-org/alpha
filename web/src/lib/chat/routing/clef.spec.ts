import { describe, expect, it } from 'vitest';
import { CLEF_LANGUAGES, OTHER_LANGUAGE, clefQuestions, mergeClef, parseClefAnswers, type ClefVerdict } from './clef';
import type { DraftAnalysis } from './classifier';
import { heuristicClassify } from './heuristic';

// Clef's answers for "Com puc renovar el DNI a València?", recorded from the router with this question set.
const RECORDED = {"language":{"type":"choice","choice":"cat","probabilities":{"arb":0.0036,"cat":0.7005,"ces":0.0052,"cmn":0.0044,"dan":0.0038,"deu":0.0055,"ell":0.0043,"eng":0.0113,"eus":0.0056,"fin":0.0044,"fra":0.0057,"glg":0.0321,"hin":0.0039,"hun":0.0037,"ind":0.0041,"ita":0.0063,"jpn":0.004,"kor":0.0034,"mri":0.0038,"nld":0.007,"pol":0.0033,"por":0.0088,"ron":0.0046,"rus":0.0038,"spa":0.09,"swe":0.0039,"swh":0.0028,"tgl":0.0043,"tha":0.0032,"tur":0.0043,"ukr":0.0038,"vie":0.0043,"zlm":0.0034,"other":0.0369},"confidence":0.4869},"size":{"type":"score","score":1.1249,"legend":{"0":"A greeting or a one-line lookup","1":"An everyday request","2":"Analysis, code, or long multi-step work"},"probabilities":{"0":0.0756,"1":0.7239,"2":0.2005},"confidence":0.3549},"skill_web_search":{"type":"noul","noul":0.5544},"skill_code":{"type":"noul","noul":0.0033},"skill_math":{"type":"noul","noul":0.0042},"skill_translation":{"type":"noul","noul":0.0051},"skill_research":{"type":"noul","noul":0.0592},"skill_reasoning":{"type":"noul","noul":0.0306}};

const verdict = (over: Partial<ClefVerdict> = {}): ClefVerdict => ({
	language: { value: 'fra', confidence: 0.7 },
	difficulty: { value: 'L', confidence: 0.8 },
	skills: { 'web-search': 0.02, code: 0.9, math: 0.01, translation: 0.01, research: 0.02, reasoning: 0.6 },
	model: 'clef',
	elapsedMs: 900,
	...over
});

describe('Clef question set', () => {
	it('lists every base benchmarked language plus "other", and no varieties or low-resource tags', () => {
		const criteria = clefQuestions().language.criteria as Record<string, string>;
		expect(Object.keys(criteria)).toEqual([...CLEF_LANGUAGES, OTHER_LANGUAGE]);
		expect(CLEF_LANGUAGES).toContain('cat');
		expect(CLEF_LANGUAGES.some((t) => t.includes('-'))).toBe(false);
		for (const t of ['gsw', 'yue', 'quz', 'yor']) expect(CLEF_LANGUAGES).not.toContain(t);
		expect(criteria.cat).toBe('Catalan');
	});
});

describe('parseClefAnswers', () => {
	it('reads a recorded Clef response into a verdict', () => {
		const v = parseClefAnswers(RECORDED, 'clef', 875);
		expect(v.language).toEqual({ value: 'cat', confidence: 0.49 });
		// The most likely size (0.72 on "an everyday request"), not the rounded expectation.
		expect(v.difficulty.value).toBe('M');
		expect(v.skills['web-search']).toBeCloseTo(0.55, 2);
		expect(v.skills.code).toBeLessThan(0.01);
		expect(v).toMatchObject({ model: 'clef', elapsedMs: 875 });
	});

	it('throws, rather than defaulting, when an answer is missing or names an unlisted language', () => {
		expect(() => parseClefAnswers({ ...RECORDED, size: undefined }, 'clef', 1)).toThrow(/size/);
		expect(() => parseClefAnswers({ ...RECORDED, language: { choice: 'klingon' } }, 'clef', 1)).toThrow(/unlisted/);
		expect(() => parseClefAnswers({ ...RECORDED, skill_code: {} }, 'clef', 1)).toThrow();
	});
});

describe('mergeClef', () => {
	const local = (text: string): DraftAnalysis => ({ ...heuristicClassify(text), source: 'local' });

	it('takes task size and skills from Clef, and names Clef as the classifier', () => {
		const text = 'Can you help me with this thing please';
		const m = mergeClef(text, local(text), verdict({ language: { value: 'eng', confidence: 0.7 } }));
		expect(m).toMatchObject({ source: 'remote', classifier: 'clef', difficulty: { value: 'L' } });
		expect(m.skills.map((s) => s.id)).toEqual(['code', 'reasoning']);
	});

	it("keeps a skill the local read was sure of even when Clef doubts it", () => {
		const text = 'What is the latest news on the Swiss election results today?';
		const l: DraftAnalysis = {
			...local(text),
			skills: [
				{ id: 'web-search', confidence: 0.9, reason: 'Asks about something recent' },
				{ id: 'math', confidence: 0.6, reason: 'Has numbers' }
			]
		};
		const m = mergeClef(text, l, verdict({ language: { value: 'eng', confidence: 0.7 } }));
		expect(m.skills.find((s) => s.id === 'web-search')).toEqual(l.skills[0]);
		// Not sure enough to outvote Clef's 0.01.
		expect(m.skills.map((s) => s.id)).not.toContain('math');
	});

	it('takes Clef’s language over a word-list read however sure that read claims to be, unless Clef is below 0.4', () => {
		const text = 'ok merci pour tout';
		const unsure: DraftAnalysis = {
			...local(text),
			language: { value: 'spa', confidence: 0.3, alternatives: [], signal: 'words' }
		};
		const m = mergeClef(text, unsure, verdict());
		expect(m.language).toMatchObject({ value: 'fra', signal: 'model' });
		expect(m.language.alternatives[0]).toEqual({ value: 'spa', confidence: 0.3 });

		const sure = { ...unsure, language: { ...unsure.language, confidence: 0.9 } };
		expect(mergeClef(text, sure, verdict()).language.value).toBe('fra');
		const clefUnsure = verdict({ language: { value: 'fra', confidence: 0.39 } });
		expect(mergeClef(text, sure, clefUnsure).language.value).toBe('spa');
	});

	it('never overrides a script, low-resource or dialect read, or with "other"', () => {
		const text = 'Allinllachu? Imaynatam kashanki?';
		for (const signal of ['low-resource', 'dialect'] as const) {
			const l: DraftAnalysis = { ...local(text), language: { value: 'quz', confidence: 0.4, alternatives: [], signal } };
			expect(mergeClef(text, l, verdict()).language.value).toBe('quz');
		}
		const thai = local('สวัสดีครับ ช่วยอะไรได้บ้าง');
		expect(thai.language.signal).toBe('script');
		expect(mergeClef('สวัสดีครับ ช่วยอะไรได้บ้าง', thai, verdict()).language.value).toBe(thai.language.value);
		const und: DraftAnalysis = { ...local(text), language: { value: 'und', confidence: 0, alternatives: [], signal: 'none' } };
		expect(mergeClef(text, und, verdict({ language: { value: OTHER_LANGUAGE, confidence: 0.9 } })).language.value).toBe('und');
	});

	it('applies dialect markers on top of a language Clef chose', () => {
		const text = 'Hui vull eixir prompte amb els xiquets, com ho faig?';
		const l: DraftAnalysis = { ...local(text), language: { value: 'und', confidence: 0, alternatives: [], signal: 'none' } };
		const m = mergeClef(text, l, verdict({ language: { value: 'cat', confidence: 0.6 } }));
		expect(m.language.value).toBe('cat-valencia');
	});
});
