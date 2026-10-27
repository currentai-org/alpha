import { chatRoutePath } from '$lib/surface';
import { defaultLocale, locales, toSupportedLocale, type Locale } from './locales';

/**
 * Public pages whose content is actually translated. Only these get /es, /fr… URLs, hreflang
 * alternates and per-language sitemap entries; every other public page is English at one URL, so
 * search engines are never told an English page is Spanish. Add a route once its content exists in
 * every locale (or falls back deliberately).
 */
const translatedRoutes: readonly string[] = ['/alpha'];

/**
 * The product: conversations, auth callbacks and API clients keep one stable URL, and the
 * interface follows the person's chosen language (cookie), then their browser's.
 */
const APP_PATH =
	/^\/(?:chat|api|auth|login|logout|oauth|rs|\.well-known)(?:\/|$)|^\/alpha\/(?:demo|chat)(?:\/|$)/;

function pathnameOf(path: string): string {
	return path.split(/[?#]/)[0] || '/';
}

/** Remove a supported locale prefix, never an arbitrary leading segment. */
export function unlocalizedPath(path: string): string {
	const prefix = path.split(/[/?#]/)[1];
	return locales.some((locale) => locale === prefix)
		? path.slice(prefix.length + 1).replace(/^(?=[?#])/, '/') || '/'
		: path;
}

function prefixLocale(path: string): Locale | undefined {
	const prefix = path.split(/[/?#]/)[1];
	return locales.find((locale) => locale === prefix);
}

function isAppPath(path: string): boolean {
	// On the chat surface every path but the shared root ones is chat's (CUR-4448, src/lib/surface.ts).
	const pathname = chatRoutePath(pathnameOf(unlocalizedPath(path)));
	return APP_PATH.test(pathname) || /\.[a-z0-9]+$/i.test(pathname);
}

export function isTranslatedRoute(path: string): boolean {
	const pathname = pathnameOf(unlocalizedPath(path)).replace(/\/__data\.json$/, '') || '/';
	return translatedRoutes.includes(pathname);
}

/** Root-relative links to translated pages gain the locale prefix; everything else is unchanged. */
export function localizedHref(href: string, locale: Locale = defaultLocale): string {
	if (!href.startsWith('/') || href.startsWith('//')) return href;
	const path = unlocalizedPath(href);
	if (!isTranslatedRoute(path) || locale === defaultLocale) return path;
	return `/${locale}${path === '/' ? '' : path}`;
}

export function localeAlternates(path: string): { locale: Locale; href: string }[] {
	return isTranslatedRoute(path)
		? locales.map((locale) => ({ locale, href: localizedHref(path, locale) }))
		: [];
}

/** The first supported language in an Accept-Language header, by q-value. */
function acceptedLocale(header: string | null | undefined): Locale | undefined {
	return (header ?? '')
		.split(',')
		.map((part) => {
			const [tag, ...params] = part.trim().split(';');
			const q = params.find((p) => p.trim().startsWith('q='));
			return { tag: tag.trim(), q: q ? Number.parseFloat(q.trim().slice(2)) : 1 };
		})
		.filter(({ tag, q }) => tag && tag !== '*' && Number.isFinite(q) && q > 0)
		.sort((a, b) => b.q - a.q)
		.map(({ tag }) => toSupportedLocale(tag))
		.find((locale) => locale !== undefined);
}

/**
 * The one answer to "which language is this request in":
 * - translated public pages: the URL (`/fr/alpha` is French, `/alpha` is English);
 * - the product: the chosen language (cookie), then the browser's, then English;
 * - every other public page: English, since nothing else on it is translated.
 */
export function resolveLocale(input: {
	pathname: string;
	cookie?: string | null;
	acceptLanguage?: string | null;
}): Locale {
	if (isTranslatedRoute(input.pathname)) return prefixLocale(input.pathname) ?? defaultLocale;
	if (isAppPath(input.pathname)) {
		return toSupportedLocale(input.cookie) ?? acceptedLocale(input.acceptLanguage) ?? defaultLocale;
	}
	return defaultLocale;
}
