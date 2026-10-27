import { describe, expect, it } from 'vitest';
import languagesFile from '$lib/chat/server/data/eval/languages.json';
import { langAttr } from './endonym';

describe('langAttr', () => {
	it('returns a valid BCP 47 tag for every evaluation language, never our internal id', () => {
		for (const l of languagesFile.languages) {
			const tag = langAttr(l.id);
			// Valid, not necessarily CLDR-canonical: Tagalog stays `tl` (canonicalises to `fil`).
			expect(() => Intl.getCanonicalLocales(tag), l.id).not.toThrow();
			expect(tag, l.id).toBe(l.bcp47);
		}
	});

	it('tags each regional variety with its region', () => {
		expect(langAttr('spa')).toBe('es-419');
		expect(langAttr('spa-ES')).toBe('es-ES');
		expect(langAttr('por')).toBe('pt-BR');
		expect(langAttr('por-PT')).toBe('pt-PT');
	});

	it('falls back to the code it was given for an id it does not know', () => {
		expect(langAttr('xx-unknown')).toBe('xx-unknown');
	});
});
