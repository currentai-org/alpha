/**
 * Belebele measures every model Auto picks from in Amharic (amh_Ethi), so the measured
 * numbers decide and no hand-set estimate does. These run on the shipped tables as they are.
 *
 * Apertus 70B (0.566 raw) leads Medium (0.441) by a wide gap. Large 4's 0.71 is provisional, from 41
 * questions (CUR-392), and Auto gives Large 4 large drafts only. At 900 questions one standard error is
 * about 0.017 raw, 0.022 once rescaled above chance, so the contract is a pick within that margin of the
 * best measured score among the models Auto may pick for the draft. (CUR-4078)
 */
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { localClassifier } from './localClassifier';
import { route } from './router';

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
