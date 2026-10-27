import { describe, expect, it } from 'vitest';
import { countryFromHeader, crisisLocale } from './crisisLocale';

describe('countryFromHeader', () => {
	it('lower-cases a two-letter code', () => {
		expect(countryFromHeader('GB')).toBe('gb');
	});

	it('rejects an absent, empty or malformed header (the card stays generic)', () => {
		for (const value of [null, undefined, '', 'G', 'GBR', '1A', 'G B']) {
			expect(countryFromHeader(value), String(value)).toBeNull();
		}
	});
});

describe('crisisLocale', () => {
	it('sends a GB visitor to findahelpline’s GB page with 999', () => {
		expect(crisisLocale('GB')).toEqual({
			code: 'gb',
			name: 'United Kingdom',
			helplineUrl: 'https://findahelpline.com/countries/gb',
			emergency: '999'
		});
	});

	it('gives an EU visitor 112', () => {
		expect(crisisLocale('DE')?.emergency).toBe('112');
		expect(crisisLocale('PT')?.helplineUrl).toBe('https://findahelpline.com/countries/pt');
	});

	it('gives US and Canadian visitors 911', () => {
		expect(crisisLocale('US')?.emergency).toBe('911');
		expect(crisisLocale('CA')?.emergency).toBe('911');
	});

	it('links a country we hold no emergency number for, with emergency null (the card says "your local emergency number")', () => {
		expect(crisisLocale('JP')).toMatchObject({
			name: 'Japan',
			helplineUrl: 'https://findahelpline.com/countries/jp',
			emergency: null
		});
	});

	it('returns null (the generic card, never a dead link) for a country findahelpline has no page for', () => {
		// Antarctica: a real ISO code with no findahelpline page.
		expect(crisisLocale('AQ')).toBeNull();
		expect(crisisLocale('XX')).toBeNull();
	});

	it('returns null (the generic card) with no country header', () => {
		expect(crisisLocale(null)).toBeNull();
		expect(crisisLocale(undefined)).toBeNull();
	});
});
