import { describe, expect, it } from 'vitest';
import { getScoreLevel } from './maturity';

describe('getScoreLevel', () => {
	it('reads leading at 4.5 and strong from 4.0, the published thresholds', () => {
		expect(getScoreLevel(4.5)).toBe('leading');
		expect(getScoreLevel(4.49)).toBe('strong');
		expect(getScoreLevel(4)).toBe('strong');
	});

	it('reads everything below 4.0, and an unscored product, as outline (available)', () => {
		expect(getScoreLevel(3.99)).toBe('outline');
		expect(getScoreLevel(null)).toBe('outline');
		expect(getScoreLevel(undefined)).toBe('outline');
	});

	it("prefers the payload's own tier over re-deriving it from the score", () => {
		expect(getScoreLevel(4.1, 'leading')).toBe('leading');
	});
});
