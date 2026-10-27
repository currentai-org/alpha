import { chatLandingSeoPage } from '$lib/website.server';
import type { PageServerLoad } from './$types';

// Chat's landing page is code-owned (CUR-2195): the models and shell come from +layout.server.ts,
// and a CMS page at slug `chat` contributes only its SEO fields, so an editor can still change
// the title and description. A missing page, a failed lookup or a build with no CMS leaves
// ChatShell's own head tags in place rather than failing the page.
export const load: PageServerLoad = async ({ fetch }) => {
	let landingSeoPage: Record<string, unknown> | null = null;
	try {
		landingSeoPage = await chatLandingSeoPage(fetch);
	} catch (err) {
		console.error('[chat-landing] SEO page lookup failed:', err);
	}
	return { landingSeoPage };
};
