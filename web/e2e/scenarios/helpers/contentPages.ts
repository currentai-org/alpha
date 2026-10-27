// Page content differs per environment, so a spec about a CMS block can't name the page that carries
// it. This reads the environment's own sitemap instead.
import { expect, type APIRequestContext } from '@playwright/test';

/** Content pages from the sitemap, as paths on this deployment. Catalog pages have no blocks. */
async function contentPaths(request: APIRequestContext): Promise<string[]> {
	const res = await request.get('/sitemap.xml');
	expect(res.ok(), 'the sitemap did not load').toBe(true);
	const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	// Preview sitemaps can carry another origin, so only the path is kept.
	return locs.map((loc) => new URL(loc).pathname).filter((p) => !/^\/(product|org)\//.test(p));
}

/**
 * The first content page whose server-rendered HTML carries `data-block="<block>"`, or null when no
 * page in this environment uses the block. Update posts are skipped: they render no page blocks.
 */
export async function pageWithBlock(
	request: APIRequestContext,
	block: string
): Promise<string | null> {
	const marker = `data-block="${block}"`;
	for (const path of await contentPaths(request)) {
		if (path.startsWith('/updates/')) continue;
		const res = await request.get(path);
		if (res.ok() && (await res.text()).includes(marker)) return path;
	}
	return null;
}
