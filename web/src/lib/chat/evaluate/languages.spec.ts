import { describe, expect, it } from 'vitest';
import { LAUNCH_LANGUAGES } from '../languageData';
import { sampleEvalApi } from './fixtures';
import { EVAL_LANGUAGES, evalLanguageId, evaluationLanguages } from './languages';

describe('evaluation language catalog', () => {
	it('offers every launch language, including English, when only three have sample answers', async () => {
		const languages = await sampleEvalApi().languages();
		expect(languages.map((l) => l.id).sort()).toEqual(LAUNCH_LANGUAGES.map(evalLanguageId).sort());
		expect(languages).toHaveLength(26);
		expect(languages.find((l) => l.id === 'eng')?.name).toBe('English');
	});

	it('keeps the complete picker when the service opens a subset, retaining service metadata and additional languages', () => {
		const available = [
			{ id: 'fra', name: 'French', dir: 'ltr' as const },
			{ id: 'jpn', name: 'Japanese', dir: 'ltr' as const }
		];
		const languages = evaluationLanguages(available);
		expect(languages).toHaveLength(27);
		expect(languages).toContainEqual(available[0]);
		expect(languages).toContainEqual(available[1]);
		expect(new Set(languages.map((l) => l.id)).size).toBe(languages.length);
		expect(languages.map((l) => l.name)).toEqual(languages.map((l) => l.name).sort((a, b) => a.localeCompare(b, 'en')));
	});

	it('uses the evaluation Mandarin code and preserves right-to-left language direction', () => {
		expect(evalLanguageId('cmn')).toBe('zho');
		expect(EVAL_LANGUAGES.find((l) => l.id === 'zho')?.name).toBe('Mandarin');
		expect(EVAL_LANGUAGES.find((l) => l.id === 'pbt')?.name).toBe('Pashto');
		expect(EVAL_LANGUAGES.find((l) => l.id === 'ben')?.name).toBe('Bengali');
		expect(EVAL_LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.id).sort()).toEqual(['arb', 'pbt', 'urd']);
	});

	it('reports missing sample answers as closed instead of claiming the person has rated everything', async () => {
		const api = sampleEvalApi();
		expect(await api.next('spa')).toEqual({ kind: 'closed', language: 'spa' });
		await expect(api.saveProfile({ language: 'spa', level: 'native', consent: true })).rejects.toMatchObject({ kind: 'closed' });
		expect(await api.next('fra')).toMatchObject({ kind: 'needs_profile', language: 'fra' });
		await api.saveProfile({ language: 'fra', level: 'native', consent: true });
		expect(await api.next('fra')).toMatchObject({ kind: 'calibration', language: 'fra' });
	});
});
