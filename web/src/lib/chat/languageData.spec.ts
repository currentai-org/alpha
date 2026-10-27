import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LANGUAGE_DATA,
	LANGUAGE_DATA,
	actionLabel,
	languageDataFor,
	offersInterest,
	partnerHref
} from './languageData';
import { MOZILLA_DATA_COLLECTIVE } from './contribute';

describe('partnerHref', () => {
	it('carries utm_source=aipotluck, the surface and the language on every partner link', () => {
		const url = new URL(
			partnerHref('https://mozilladatacollective.com/profile/submissions/create', {
				language: 'quz',
				surface: 'composer_language_panel'
			})
		);
		expect(url.origin + url.pathname).toBe('https://mozilladatacollective.com/profile/submissions/create');
		expect(url.searchParams.get('utm_source')).toBe('aipotluck');
		expect(url.searchParams.get('utm_content')).toBe('composer_language_panel');
		expect(url.searchParams.get('utm_term')).toBe('quz');
		expect(url.searchParams.get('language')).toBe('quz');
	});

	it('sends no utm_term for an unknown language, so the Data Collective does not search for "und"', () => {
		const url = new URL(partnerHref(MOZILLA_DATA_COLLECTIVE.contributeLanguage, { language: 'und', surface: 'contribute_page' }));
		expect(url.searchParams.has('utm_term')).toBe(false);
		expect(url.searchParams.has('language')).toBe(false);
		expect(url.searchParams.get('utm_source')).toBe('aipotluck');
	});

	it("keeps the partner's own query parameters", () => {
		const url = new URL(partnerHref('https://example.org/x?lang=yo', { language: 'yor', surface: 'contribute_page' }));
		expect(url.searchParams.get('lang')).toBe('yo');
		expect(url.searchParams.get('language')).toBe('yor');
	});
});

describe('languageDataFor', () => {
	it('falls back from a variety to its base language, then to the default', () => {
		LANGUAGE_DATA.por = { actions: [] };
		try {
			expect(languageDataFor('por-BR').actions.map((a) => a.id)).toEqual(['cv_speak']);
			expect(languageDataFor('yor').actions.slice(1)).toEqual(DEFAULT_LANGUAGE_DATA.actions);
		} finally {
			delete LANGUAGE_DATA.por;
		}
	});

	it('offers the interest form whenever a language has nothing to contribute to', () => {
		expect(offersInterest({ actions: [] })).toBe(true);
		expect(offersInterest({ actions: DEFAULT_LANGUAGE_DATA.actions })).toBe(false);
		expect(offersInterest({ actions: DEFAULT_LANGUAGE_DATA.actions, interest: true })).toBe(true);
	});

	it('opens every language with Common Voice, then the Data Collective', () => {
		expect(languageDataFor('cat').actions.map((a) => a.id)).toEqual(['cv_speak', 'mdc_share']);
		expect(languageDataFor('quz').actions.map((a) => a.id)).toEqual(['cv_request', 'mdc_share']);
		expect(languageDataFor('cat').actions[0].href).toBe('https://commonvoice.mozilla.org/ca/speak');
		expect(languageDataFor('cat').actions[1].href).toBe('https://mozilladatacollective.com/contribute-language');
	});

	it('keeps the interest form tied to partner projects, not to the Common Voice action', () => {
		LANGUAGE_DATA.quz = { actions: [] };
		try {
			const entry = languageDataFor('quz');
			expect(entry.actions.map((a) => a.id)).toEqual(['cv_request']);
			expect(offersInterest(entry)).toBe(true);
		} finally {
			delete LANGUAGE_DATA.quz;
		}
	});

	it('leaves Common Voice out when an entry opts out', () => {
		LANGUAGE_DATA.quz = { actions: [], commonVoice: false };
		try {
			expect(languageDataFor('quz').actions).toEqual([]);
		} finally {
			delete LANGUAGE_DATA.quz;
		}
	});

	it('names the language in every default action label', () => {
		for (const action of ['cat', 'tgl', 'quz'].flatMap((tag) => languageDataFor(tag).actions)) {
			expect(actionLabel(action, 'Quechua')).toContain('Quechua');
		}
	});
});
