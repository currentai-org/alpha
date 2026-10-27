import { redirect, type Handle } from '@sveltejs/kit';
import { defineCustomServerStrategy, getTextDirection } from '$lib/paraglide/runtime.js';
import { paraglideMiddleware } from '$lib/paraglide/server.js';
import { isTranslatedRoute, resolveLocale, unlocalizedPath } from './routing';
import { defaultLocale, localeCookieName } from './locales';

function cookieValue(header: string | null, name: string): string | undefined {
	for (const part of (header ?? '').split(';')) {
		const [key, ...value] = part.trim().split('=');
		if (key === name) return decodeURIComponent(value.join('='));
	}
	return undefined;
}

defineCustomServerStrategy('custom-interface', {
	getLocale: (request) => {
		if (!request) return defaultLocale;
		return resolveLocale({
			pathname: new URL(request.url).pathname,
			cookie: cookieValue(request.headers.get('cookie'), localeCookieName),
			acceptLanguage: request.headers.get('accept-language')
		});
	}
});

/** Resolves the request's language once and makes it the Paraglide locale for the whole request. */
export const handleLocale: Handle = async ({ event, resolve }) => {
	// `url.search` is read only on the redirect: a prerendered page (roadmap-v2) throws on any read.
	const { pathname } = event.url;
	const bare = unlocalizedPath(pathname);
	// A language prefix exists only on translated pages, and English never carries one.
	if (
		pathname !== bare &&
		(!isTranslatedRoute(bare) || pathname === '/en' || pathname.startsWith('/en/'))
	) {
		throw redirect(308, `${bare}${event.url.search}`);
	}
	return paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		event.locals.locale = locale;
		// Following /fr/alpha into the demo or chat keeps French: a prefixed URL is a language choice.
		if (pathname !== bare && event.cookies.get(localeCookieName) !== locale) {
			event.cookies.set(localeCookieName, locale, {
				path: '/',
				httpOnly: false,
				sameSite: 'lax',
				secure: event.url.protocol === 'https:',
				maxAge: 60 * 60 * 24 * 365
			});
		}
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});
	});
};
