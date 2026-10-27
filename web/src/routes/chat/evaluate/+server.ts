import { redirect } from '@sveltejs/kit';
import { base } from '$lib/chat/paths';
import type { RequestHandler } from './$types';

/**
 * Evaluation moved into settings, so the settings nav stays beside it. Links already out there
 * (shared, bookmarked, an older Potluck Run end screen) land on the same page in the same language.
 */
export const GET: RequestHandler = ({ url }) => {
	redirect(308, `${base}/settings/evaluate${url.search}`);
};
