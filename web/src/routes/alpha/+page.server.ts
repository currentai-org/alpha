import { alphaLandingContent } from '$lib/website.server';
import { normalizeLocale } from '$lib/i18n/locales';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, url, cookies, parent, setHeaders }) => {
	const { locale } = await parent();
	const { content, previewSecret } = await alphaLandingContent(
		fetch,
		normalizeLocale(locale),
		url,
		cookies
	);
	if (previewSecret) setHeaders({ 'cache-control': 'private, no-store' });
	return {
		alphaLanding: content,
		isPreview: Boolean(previewSecret)
	};
};
