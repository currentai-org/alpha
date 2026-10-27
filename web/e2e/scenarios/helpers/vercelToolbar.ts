import type { Page } from '@playwright/test';

/**
 * Vercel injects its feedback toolbar (vercel.live feedback.js) into preview deployments: a round
 * ▲-and-list button on the right edge that production never serves. In a recording the journey
 * critic grades it as our own UI (CUR-2148, "an unlabeled floating icon"), and at phone width it sits
 * over the send button and takes the tap (CUR-2132). `x-vercel-skip-toolbar` opts automation out.
 *
 * Same-origin requests only: on a cross-origin fetch a custom header forces a CORS preflight the
 * target may refuse, which is why this is not a global `extraHTTPHeaders` (CUR-1553).
 */
export async function skipVercelToolbar(page: Page, baseURL: string): Promise<void> {
	const origin = new URL(baseURL).origin;
	await page.route(
		(url) => url.origin === origin,
		(route) =>
			route.fallback({ headers: { ...route.request().headers(), 'x-vercel-skip-toolbar': '1' } })
	);
}
