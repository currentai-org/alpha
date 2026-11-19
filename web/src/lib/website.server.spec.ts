import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/public';
import { chatLandingSeoPage, maintenanceBanner } from './website.server';

describe('website.server with no CMS origin configured (a self-hosted build)', () => {
	it('reports no maintenance banner and no /chat SEO page instead of throwing', async () => {
		const e = env as Record<string, string | undefined>;
		const before = e.PUBLIC_CMS_PAYLOAD_URL;
		delete e.PUBLIC_CMS_PAYLOAD_URL;
		const failFetch = (() => {
			throw new Error('no request may be made without a CMS origin');
		}) as unknown as typeof fetch;
		try {
			expect(await maintenanceBanner(failFetch)).toEqual({ enabled: false });
			expect(await chatLandingSeoPage(failFetch)).toBeNull();
		} finally {
			if (before !== undefined) e.PUBLIC_CMS_PAYLOAD_URL = before;
		}
	});
});
