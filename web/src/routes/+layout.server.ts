import { defaultLocale } from '$lib/i18n/locales';
import { siteLayoutData } from '$lib/website.server';
import type { LayoutServerLoad } from './$types';

// The root layout carries the page language. The website's menus, footer and gap map version come
// from the website itself when it is in the build (lib/website/layoutData.ts) and are absent otherwise.
export const load: LayoutServerLoad = async ({ fetch, route, locals }) => ({
	locale: locals?.locale ?? defaultLocale,
	...(await siteLayoutData({ fetch, route, locals }))
});
