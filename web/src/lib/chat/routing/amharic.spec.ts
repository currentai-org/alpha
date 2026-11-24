/**
 * Belebele measures every model Auto picks from in Amharic (amh_Ethi), so the measured
 * numbers decide and no hand-set estimate does. These run on the shipped tables as they are.
 *
 * Apertus 70B (0.566 raw) leads Medium (0.441) by a wide gap. Large 4's 0.71 is provisional, from 41
 * questions, and Auto gives Large 4 large drafts only. At 900 questions one standard error is
 * about 0.017 raw, 0.022 once rescaled above chance, so the contract is a pick within that margin of the
 * best measured score among the models Auto may pick for the draft.
 */
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { localClassifier } from './localClassifier';
import { DEFAULT_ROUTING, route, stillLearning } from './router';
import { SHIPPED_LANGUAGE_SCORES, measuredScore, type LanguageScores } from './languageScores';
import { draftIn, type DraftAnalysis } from './classifier';

/** One Belebele standard error at 900 questions, rescaled above the 0.25 chance floor. */
const NOISE = 0.022;

const SERVED = catalog.filter((m) => m.status === 'live').map((m) => m.gatewayId!);

const AMHARIC = [
	'ሰላም፣ እንዴት ነህ?',
	'የኢትዮጵያ ዋና ከተማ ማን ናት?',
	'በቫይረስ እና በባክቴሪያ መካከል ያለውን ልዩነት አስረዳኝ',
	'ፕሮግራሚንግ መማር እፈልጋለሁ፣ ከየት ልጀምር?'
];

describe('Auto, Amharic drafts, every model healthy', () => {
	it.each(AMHARIC)('reads Amharic: %s', async (text) => {
		expect((await localClassifier(text)).language.value).toBe('amh');
	});

	it.each(AMHARIC)(
		'sends an Amharic draft to the available model with the best measured Amharic score, within the noise of Belebele, never on a hand-set estimate: %s',
		async (text) => {
			const choice = route(await localClassifier(text), SERVED)!;
			const picked = choice.scores.find((s) => s.model.id === choice.model.id)!;
			expect(picked.languageVia, 'the pick rests on a measured Amharic score').toBe('measured');
			const candidates = choice.scores.filter((s) => s.available && s.benchmarked);
			for (const s of candidates) {
				expect(s.languageVia, `${s.model.id} is ranked on a hand-set estimate`).not.toBe('exact');
				expect(s.languageVia, `${s.model.id} is ranked on a hand-set estimate`).not.toBe('default');
			}
			const bestMeasured = Math.max(...candidates.filter((s) => s.languageVia === 'measured').map((s) => s.language));
			expect(picked.language, 'the pick is measurably worse in Amharic than another available model').toBeGreaterThanOrEqual(
				bestMeasured - NOISE
			);
		}
	);
});

/** A draft read, surely, as Amharic. */
const amharic = (size: 'S' | 'M' | 'L' = 'M', confidence = 0.95): DraftAnalysis => draftIn('amh', size, confidence);

/** The decision under review: under 0.75 raw on Belebele, a model is still learning the language. */
const STILL_LEARNING_RAW = 0.75;

// Every catalog model with a measured Amharic score, read from the shipped scores, so no list is kept by hand.
const MEASURED_IN_AMHARIC = catalog
	.map((model) => ({ model, measured: measuredScore(SHIPPED_LANGUAGE_SCORES, model.id, 'amh') }))
	.filter((m) => m.measured);

describe('the still-learning notice, keyed on the model that answers', () => {
	it.each(MEASURED_IN_AMHARIC.map((m) => [m.model.id, m.measured!.raw] as const))(
		'shows for %s answering Amharic exactly when its raw Belebele Amharic score (%s) is under 0.75',
		(id, raw) => {
			const gap = stillLearning(amharic(), id);
			expect(!!gap, `${id} at raw ${raw}`).toBe(raw < STILL_LEARNING_RAW);
			if (gap) expect(gap).toMatchObject({ tag: 'amh', model: id });
		}
	);

	it('shows for Large 4, Medium 3.5, Apertus 1.5 70B and Bielik 11B, and not for GLM 5.2, on the shipped scores', () => {
		for (const id of ['mistral-large-4', 'mistral-medium', 'apertus-70b', 'bielik-11b']) {
			expect(stillLearning(amharic(), id), id).toBeDefined();
		}
		expect(stillLearning(amharic(), 'glm-5.2')).toBeUndefined();
	});

	it('shows for a hand pick of Large 4 on a short Amharic draft, whatever Auto would have chosen', async () => {
		const draft = await localClassifier(AMHARIC[1]);
		const choice = route(draft, SERVED)!;
		const gap = stillLearning(draft, 'mistral-large-4', {}, choice.scores);
		expect(gap).toMatchObject({ tag: 'amh', model: 'mistral-large-4' });
		expect(gap!.support).toBeLessThan(DEFAULT_ROUTING.weakSupport);
	});

	it.each(['S', 'M', 'L'] as const)(
		'Auto raises the notice on a %s Amharic draft exactly when the model it picks scores under 0.75 raw',
		(size) => {
			const choice = route(amharic(size), SERVED)!;
			const raw = measuredScore(SHIPPED_LANGUAGE_SCORES, choice.model.id, 'amh')?.raw;
			expect(raw, `${choice.model.id} has a measured Amharic score`).toBeDefined();
			expect(!!choice.gap, `${choice.model.id} at raw ${raw}`).toBe(raw! < STILL_LEARNING_RAW);
			if (choice.gap) expect(choice.gap.model).toBe(choice.model.id);
		}
	);

	it('puts the line at 0.75 raw: 0.75 clears it, 0.745 does not', () => {
		const scores = (raw: number): LanguageScores => ({
			version: 1,
			benchmarks: SHIPPED_LANGUAGE_SCORES.benchmarks,
			scores: { 'belebele-2026-10-16': { 'glm-5.2': { amh: raw } } }
		});
		expect(stillLearning(amharic(), 'glm-5.2', { languageScores: scores(0.75) })).toBeUndefined();
		expect(stillLearning(amharic(), 'glm-5.2', { languageScores: scores(0.745) })).toBeDefined();
	});

	it('stays quiet on an unsure language guess, even for a model weak in Amharic', () => {
		expect(stillLearning(amharic('M', 0.3), 'bielik-11b')).toBeUndefined();
	});
});
