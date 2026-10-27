import { describe, expect, it } from 'vitest';
import { commonVoiceLanguagesHref, commonVoiceLink } from './commonVoice';
import { COMMON_VOICE_LOCALES } from './commonVoiceLocales.generated';
import { LAUNCH_LANGUAGES } from './languageData';

describe('commonVoiceLink', () => {
	it("links a language Common Voice takes straight to its recording screen, under Common Voice's own code", () => {
		expect(commonVoiceLink('cat')).toEqual({
			kind: 'speak',
			locale: 'ca',
			href: 'https://commonvoice.mozilla.org/ca/speak'
		});
		expect(commonVoiceLink('cmn').href).toBe('https://commonvoice.mozilla.org/zh-CN/speak');
		expect(commonVoiceLink('pbt').href).toBe('https://commonvoice.mozilla.org/ps/speak');
		expect(commonVoiceLink('gsw').href).toBe('https://commonvoice.mozilla.org/gsw/speak');
	});

	it('links a variety tag through its base language', () => {
		expect(commonVoiceLink('cat-valencia').href).toBe('https://commonvoice.mozilla.org/ca/speak');
		expect(commonVoiceLink('por-BR').href).toBe('https://commonvoice.mozilla.org/pt/speak');
	});

	it('sends Cusco Quechua to the request form, never to a different Quechua variety Common Voice has', () => {
		expect(COMMON_VOICE_LOCALES.has('quy')).toBe(true);
		expect(commonVoiceLink('quz')).toEqual({
			kind: 'request',
			href: 'https://commonvoice.mozilla.org/en/language/request'
		});
		expect(commonVoiceLink('quy').kind).toBe('speak');
	});

	it('sends a language Common Voice lists but cannot take contributions in yet (Tagalog) to its language list, not the request form', () => {
		expect(commonVoiceLink('tgl', 'fr')).toEqual({
			kind: 'in_progress',
			locale: 'tl',
			href: 'https://commonvoice.mozilla.org/fr/languages'
		});
	});

	it("shows the request form and language list in the person's interface language, English otherwise", () => {
		expect(commonVoiceLink('quz', 'es').href).toBe('https://commonvoice.mozilla.org/es/language/request');
		expect(commonVoiceLink('quz', 'ja').href).toBe('https://commonvoice.mozilla.org/en/language/request');
		expect(commonVoiceLanguagesHref('de')).toBe('https://commonvoice.mozilla.org/de/languages');
	});

	it('maps every launch language except Tagalog to a locale Common Voice takes', () => {
		const unmapped = LAUNCH_LANGUAGES.filter((tag) => commonVoiceLink(tag).kind !== 'speak');
		expect(unmapped).toEqual(['tgl']);
	});
});
