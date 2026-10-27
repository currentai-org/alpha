// e2e-product: @chat
// e2e-area: @models
import { test, expect } from './helpers/test';

// The models list at /chat/models is gone; a model's own page (/chat/models/<id>) stays. The rest
// parameter of that page also matches the bare /chat/models, so without a redirect an old link to the
// list would open a chat with no model in it. A crawler or an old bookmark reads the raw response, so
// the check reads it without following the redirect.

test(
	'/chat/models, the removed models list, redirects permanently to the chat instead of opening a chat with no model',
	{ tag: ['@CUR-1385'] },
	async ({ request }) => {
		const res = await request.get('/chat/models', { maxRedirects: 0 });
		expect(res.status(), 'the bare models URL did not redirect').toBe(308);
		expect(new URL(res.headers()['location'], 'http://x').pathname).toBe('/chat/');
	}
);
