import { browser } from '$app/environment';
import { goto, invalidateAll } from '$app/navigation';
import { defineCustomClientStrategy, getTextDirection } from '$lib/paraglide/runtime.js';
import { defaultLocale, localeCookieName, normalizeLocale, type Locale } from './locales';
import { isTranslatedRoute, localizedHref } from './routing';

// The browser's current locale is reactive state, so every `m.key()` in a template re-renders when
// the language changes, without remounting the app (drafts and open conversations survive).
const active = $state({
	locale: browser ? normalizeLocale(document.documentElement.lang) : defaultLocale
});

if (browser) {
	defineCustomClientStrategy('custom-interface', {
		getLocale: () => active.locale,
		// Paraglide also calls this on its first getLocale(), from inside a render; writing only on a
		// real change keeps that read from mutating state mid-render.
		setLocale: (locale) => {
			const next = normalizeLocale(locale);
			if (active.locale !== next) active.locale = next;
		}
	});
}

/** Follow the locale the server resolved for the current page (navigation, invalidation). */
export function syncInterfaceLocale(value: unknown): void {
	const locale = normalizeLocale(value);
	if (active.locale !== locale) active.locale = locale;
	document.documentElement.lang = locale;
	document.documentElement.dir = getTextDirection(locale);
}

/** The person's explicit choice: remembered in a cookie, applied in place where the URL allows. */
export async function setInterfaceLocale(value: Locale): Promise<void> {
	const locale = normalizeLocale(value);
	const secure = location.protocol === 'https:' ? '; secure' : '';
	document.cookie = `${localeCookieName}=${locale}; path=/; max-age=31536000; samesite=lax${secure}`;
	const { pathname, search, hash } = location;
	if (isTranslatedRoute(pathname)) {
		// Locale prefixes are handled by reroute, outside the generated filesystem RouteId union.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(localizedHref(`${pathname}${search}${hash}`, locale), {
			invalidateAll: true,
			noScroll: true,
			keepFocus: true
		});
	} else {
		syncInterfaceLocale(locale);
		await invalidateAll();
	}
}
