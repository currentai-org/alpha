import { describe, expect, it } from 'vitest';
import { parseGeneratedSamples } from './generated';
import { sampleEvalApi } from './fixtures';

const pool = {
	version: 1,
	items: { eng: [{ runId: 'generated-english', safety: false, prompt: 'A fixed request', answer: 'An actual generated answer', reference: [] }] },
	calibration: {}
};

describe('generated evaluation preview', () => {
	it('uses generated answers without silently mixing handwritten fixtures or saving ratings', async () => {
		const api = sampleEvalApi(undefined, parseGeneratedSamples(pool));
		expect(api.sample).toBe(true);
		expect(await api.next('fra')).toEqual({ kind: 'closed', language: 'fra' });
		await api.saveProfile({ language: 'eng', level: 'native', consent: true });
		expect(await api.next('eng')).toMatchObject({ kind: 'rate', runId: 'generated-english', answer: 'An actual generated answer' });
	});

	it('rejects empty responses and unknown languages instead of offering them for rating', () => {
		expect(() => parseGeneratedSamples({ ...pool, items: { eng: [{ ...pool.items.eng[0], answer: '' }] } })).toThrow();
		expect(() => parseGeneratedSamples({ ...pool, items: { invented: pool.items.eng } })).toThrow('Unknown generated evaluation language');
		expect(parseGeneratedSamples({ version: 1, items: {}, calibration: {} })).toBeNull();
	});
});
