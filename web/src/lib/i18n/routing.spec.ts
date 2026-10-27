import { describe, expect, it } from 'vitest';
import { locales, localeName, normalizeLocale } from './locales';
import { localeAlternates, localizedHref, resolveLocale, unlocalizedPath } from './routing';

describe('locale URLs exist only for translated pages', () => {
	it.each(locales)('builds %s links to a translated page without changing query/hash', (locale) => {
		const expected = locale === 'en' ? '/alpha?q=test#faq' : `/${locale}/alpha?q=test#faq`;
		expect(localizedHref('/alpha?q=test#faq', locale)).toBe(expected);
		expect(unlocalizedPath(expected)).toBe('/alpha?q=test#faq');
	});
	it.each(['/', '/map', '/about', '/product/vllm', '/updates/x'])(
		'leaves untranslated public page %s at its one English URL',
		(path) => {
			expect(localizedHref(path, 'fr')).toBe(path);
			expect(localeAlternates(path)).toEqual([]);
		}
	);
	it.each([
		'/chat',
		'/chat/conversation/123',
		'/api/cms/invalidate',
		'/auth/callback',
		'/alpha/demo',
		'/favicon.svg',
		'/rs/e'
	])('never prefixes product path %s', (path) => {
		expect(localizedHref(path, 'es')).toBe(path);
	});
	it('leaves external links and unknown language segments alone', () => {
		expect(localizedHref('https://example.com/test', 'fr')).toBe('https://example.com/test');
		expect(localizedHref('//example.com/test', 'fr')).toBe('//example.com/test');
		expect(unlocalizedPath('/other/page')).toBe('/other/page');
	});
	it('advertises one alternate per locale for a translated page', () => {
		expect(localeAlternates('/es/alpha').map((a) => a.href)).toEqual(
			locales.map((l) => (l === 'en' ? '/alpha' : `/${l}/alpha`))
		);
	});
});

describe('resolveLocale is the single source of a request language', () => {
	it('takes a translated page from its URL, over a conflicting cookie', () => {
		expect(resolveLocale({ pathname: '/fr/alpha', cookie: 'de' })).toBe('fr');
		expect(resolveLocale({ pathname: '/alpha', cookie: 'de' })).toBe('en');
		expect(resolveLocale({ pathname: '/es/alpha/__data.json' })).toBe('es');
	});
	it('takes the product from the cookie, then the browser, then English', () => {
		expect(resolveLocale({ pathname: '/chat', cookie: 'de', acceptLanguage: 'fr' })).toBe('de');
		expect(resolveLocale({ pathname: '/chat', acceptLanguage: 'it, fr-CA;q=0.8' })).toBe('fr');
		expect(resolveLocale({ pathname: '/alpha/demo', acceptLanguage: 'ja' })).toBe('en');
	});
	it('keeps untranslated public pages English whatever the visitor prefers', () => {
		expect(resolveLocale({ pathname: '/map', cookie: 'fr', acceptLanguage: 'fr' })).toBe('en');
	});
});

describe('locale helpers', () => {
	it('normalizes interface tags without borrowing model-language identifiers', () => {
		expect(normalizeLocale('FR-CA')).toBe('fr');
		expect(normalizeLocale('spa')).toBe('en');
		expect(normalizeLocale(undefined)).toBe('en');
	});
	it('ranks Accept-Language by q-value, skipping unsupported tags', () => {
		const chat = (acceptLanguage: string) => resolveLocale({ pathname: '/chat', acceptLanguage });
		expect(chat('de;q=0.4, es;q=0.9, *')).toBe('es');
		expect(chat('')).toBe('en');
	});
	it('names every locale in its own language', () => {
		expect(locales.map(localeName)).toEqual(['English', 'Español', 'Français', 'Deutsch']);
	});
});
