// e2e-product: @chat @site
// e2e-area: @turn
import { test, expect } from './helpers/test';

// A CMS publish reaches two routes, one per product. The site's `/api/cms/invalidate`
// clears the site's cached CMS reads and its CDN copies, and on a build that serves chat too hands the
// publish to chat in process. Chat's own `/chat/api/cms/invalidate` is where the chat host answers the
// same address (surface.ts reroutes it there), and where www forwards every publish. Payload signs
// each publish with CMS_REVALIDATE_SECRET.
//
// The unsigned cases run everywhere. The signed ones need the preview's own secret, which the
// scenario workflow reads from the preview config; without it they are left out, and say so.

const SITE_ROUTE = '/api/cms/invalidate';
const CHAT_ROUTE = '/chat/api/cms/invalidate';
const MAINTENANCE_SAVE = { global: 'chat-maintenance', doc: { enabled: false } };
const secret = process.env.CMS_REVALIDATE_SECRET;

for (const route of [SITE_ROUTE, CHAT_ROUTE]) {
	test(
		`${route} refuses a publish with no secret or the wrong one`,
		{ tag: ['@CUR-5134'] },
		async ({ request }) => {
			const unsigned = await request.post(route, { data: MAINTENANCE_SAVE });
			expect(unsigned.status(), `an unsigned publish to ${route}`).toBe(401);
			const wrong = await request.post(route, {
				data: MAINTENANCE_SAVE,
				headers: { 'x-cms-revalidate-secret': 'not-the-secret' }
			});
			expect(wrong.status(), `a wrongly signed publish to ${route}`).toBe(401);
		}
	);
}

test.describe('a signed publish', () => {
	test.skip(!secret, 'CMS_REVALIDATE_SECRET is not set for this run');

	test(
		"chat's own webhook clears chat's cached maintenance banner for a maintenance save",
		{ tag: ['@CUR-5134'] },
		async ({ request }) => {
			const res = await request.post(CHAT_ROUTE, {
				data: MAINTENANCE_SAVE,
				headers: { 'x-cms-revalidate-secret': secret! }
			});
			expect(res.status()).toBe(200);
			expect(await res.json()).toEqual({ invalidated: [['payload', 'maintenance-banner']] });
		}
	);

	test(
		"the site's webhook clears the site's reads and purges the CMS page tag for the same save",
		{ tag: ['@CUR-5134'] },
		async ({ request }) => {
			const res = await request.post(SITE_ROUTE, {
				data: MAINTENANCE_SAVE,
				headers: { 'x-cms-revalidate-secret': secret! }
			});
			expect(res.status()).toBe(200);
			expect(await res.json()).toEqual({
				invalidated: [['payload', 'maintenance-banner']],
				purgedTags: ['cms-page']
			});
		}
	);
});
