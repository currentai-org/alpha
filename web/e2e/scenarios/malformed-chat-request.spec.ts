// e2e-product: @chat
// e2e-area: @turn
// A client that posts a chat turn with a malformed body is told so with a 400 naming the bad field.
// It used to be a thrown ZodError, which SvelteKit answered 500 and the exception capture counted, so a
// load harness sending a non-UUID id paged potluck-alerts. The conversation is created through
// the API with no message, so the test costs no model turn.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';

test(
	'a chat turn posted with a malformed body is answered 400 naming the bad field, not 500',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		await signInAsFreshUser(page);
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId } = (await created.json()) as { conversationId: string };

		// From the page, as the client sends it: a multipart POST with no Origin header (page.request) is
		// refused 403 by SvelteKit's CSRF check before the route runs, which proves nothing here.
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const send = async (data: string) => {
			await page.waitForLoadState('load');
			return page.evaluate(
				async ({ path, data }) => {
					const form = new FormData();
					form.set('data', data);
					const res = await fetch(path, { method: 'POST', body: form });
					return { status: res.status, text: await res.text() };
				},
				{ path: `/chat/conversation/${conversationId}`, data }
			);
		};

		const badId = await send(JSON.stringify({ inputs: 'hi', id: 'not-a-uuid' }));
		expect(badId.status, 'a non-UUID id').toBe(400);
		expect(badId.text).toContain('id');

		const badMode = await send(JSON.stringify({ inputs: 'hi', webSearchMode: 'sometimes' }));
		expect(badMode.status, 'a web search mode outside off/auto/always').toBe(400);
		expect(badMode.text).toContain('webSearchMode');

		const notJson = await send('{not json');
		expect(notJson.status, 'a data field that is not JSON').toBe(400);
	}
);
