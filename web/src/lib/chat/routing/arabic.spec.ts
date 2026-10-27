/**
 * Auto must not route Arabic drafts on hand-set estimates (such as 0.65 for Apertus 70B
 * against Mistral Large's 0.35 default for a language its row doesn't list). Once a model has a measured
 * Arabic score, that number decides and every hand-set estimate for Arabic steps aside
 * (languageScores.ts `neutralSupport`), so these run on the shipped tables as they are.
 *
 * Large 4 (0.937 raw) and Medium (0.92, provisional: Large 4's score in CIP's run, CUR-392) are both
 * measured and both strong in Arabic, and Auto gives Large 4 large drafts only. So a small or medium
 * Arabic draft goes to Medium: the pick must rest on a measured score within `MARGIN` of the best one,
 * and a large draft the classifier is sure of still goes to the best measured model. (CUR-4042)
 */
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { localClassifier } from './localClassifier';
import { route } from './router';

const SERVED = catalog.filter((m) => m.status === 'live').map((m) => m.gatewayId!);

/** How far below the best measured Arabic score (rescaled) a pick may sit: Medium's gap to Large 4 is 0.02. */
const MARGIN = 0.1;

const ARABIC = [
	'مرحبا، كيف حالك؟',
	'ما هي عاصمة المغرب؟',
	'اشرح لي الفرق بين الفيروس والبكتيريا',
	'أريد أن أتعلم البرمجة، من أين أبدأ؟',
	'اكتب لي رسالة رسمية لطلب إجازة من العمل',
	'ما هي أفضل طريقة لتعلم اللغة الإنجليزية؟'
];

describe('Auto, Arabic drafts, every model healthy', () => {
	it.each(ARABIC)('reads Arabic: %s', async (text) => {
		expect((await localClassifier(text)).language.value).toBe('arb');
	});

	it.each(ARABIC)(
		'sends an Arabic draft to a model measured within MARGIN of the best Arabic score, never on a hand-set estimate: %s',
		async (text) => {
			const choice = route(await localClassifier(text), SERVED)!;
			const picked = choice.scores.find((s) => s.model.id === choice.model.id)!;
			expect(picked.languageVia, 'the pick rests on a measured Arabic score').toBe('measured');
			const candidates = choice.scores.filter((s) => s.available && s.benchmarked);
			for (const s of candidates) {
				expect(s.languageVia, `${s.model.id} is ranked on an estimate`).not.toBe('exact');
				expect(s.languageVia, `${s.model.id} is ranked on an estimate`).not.toBe('default');
			}
			const bestMeasured = Math.max(...candidates.filter((s) => s.languageVia === 'measured').map((s) => s.language));
			expect(picked.language, 'the pick is measurably worse in Arabic than MARGIN allows').toBeGreaterThanOrEqual(
				bestMeasured - MARGIN
			);
		}
	);

	it('sends a large Arabic task the classifier is sure of to the best measured Arabic model', async () => {
		const text = ARABIC[4];
		const analysis = await localClassifier(text);
		const sure = { ...analysis, difficulty: { value: 'L' as const, confidence: 0.9 } };
		const choice = route(sure, SERVED)!;
		const best = Math.max(...choice.scores.filter((s) => s.available && s.benchmarked && s.languageVia === 'measured').map((s) => s.language));
		expect(choice.scores.find((s) => s.model.id === choice.model.id)!.language).toBe(best);
	});
});
