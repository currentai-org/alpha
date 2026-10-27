import { baseLocale, isLocale, locales, type Locale } from '$lib/paraglide/runtime.js';

/**
 * Interface locales come from `project.inlang/settings.json` and nowhere else. Model reply
 * languages are a separate ISO 639-3 catalog.
 */
export { locales, type Locale };
export const defaultLocale: Locale = baseLocale;
export const localeCookieName = 'PARAGLIDE_LOCALE';

/** A language's name for itself ("Deutsch", "Español"), from the platform's CLDR data. */
export function localeName(locale: Locale): string {
	const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
	return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

/** The supported locale for a language tag ("fr-CA" → "fr"), or undefined. */
export function toSupportedLocale(value: unknown): Locale | undefined {
	if (typeof value !== 'string') return undefined;
	const language = value.toLowerCase().split(/[-_]/)[0];
	return isLocale(language) ? language : undefined;
}

export function normalizeLocale(value: unknown): Locale {
	return toSupportedLocale(value) ?? defaultLocale;
}
