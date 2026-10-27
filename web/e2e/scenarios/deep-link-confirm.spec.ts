// e2e-product: @chat
// e2e-area: @turn
// A link carrying `?q=` and `?attachments=` must not send a prompt or fetch a file from the
// visitor's account until they confirm it. Before the fix both happened on page load: whoever wrote
// the link chose the text, the files and (on /chat/models/<id>) the model.
//
// The fetch-url proxy is answered in the browser and the first message POST is aborted, so neither
// test reaches a third-party host or bills a model turn.
import { test, expect, type Page, type Request } from './helpers/test';
import { CHAT_ENTRY } from './helpers/chatEntry';
import { signInAsFreshUser } from './helpers/session';

test.use({ viewport: { width: 1280, height: 800 } });

const ATTACHMENT = 'https://attacker.example/notes.txt';

/** Every request the page makes that would act on the link: creating a conversation or fetching a file. */
function watchActions(page: Page) {
	const seen: string[] = [];
	const acts = (r: Request) =>
		(r.method() === 'POST' && /\/chat\/conversation$/.test(new URL(r.url()).pathname)) ||
		new URL(r.url()).pathname.endsWith('/chat/api/fetch-url');
	page.on('request', (r) => {
		if (acts(r)) seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
	});
	return seen;
}

async function openLink(page: Page, prompt: string) {
	const params = new URLSearchParams({ q: prompt, attachments: ATTACHMENT });
	await page.goto(`${CHAT_ENTRY}?${params}`, { waitUntil: 'load' });
	await page
		.getByRole('dialog', { name: 'Welcome to Alpha' })
		.getByRole('button', { name: /start chatting/i })
		.click({ timeout: 8_000 })
		.catch(() => {});
	return page.getByRole('dialog', { name: 'Send this prompt?' });
}

test.beforeEach(async ({ page }) => {
	await signInAsFreshUser(page);
	await page.route('**/chat/api/fetch-url**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/plain', body: 'attached by a link' })
	);
});

test(
	'a crafted /chat link sends nothing and fetches nothing until the visitor confirms, and Cancel drops it',
	{ tag: ['@preview-only', '@CUR-2644'] },
	async ({ page }) => {
		const prompt = `Deep link prompt ${Date.now()}`;
		const actions = watchActions(page);

		const dialog = await openLink(page, prompt);
		await expect(
			dialog,
			`no confirmation appeared; the link did this on its own: ${JSON.stringify(actions)}`
		).toBeVisible({ timeout: 20_000 });
		await expect(dialog).toContainText(prompt);
		await expect(dialog).toContainText('attacker.example');
		// Stripped from the address bar as soon as it was read, so a reload cannot replay it.
		await expect.poll(() => new URL(page.url()).search).toBe('');
		expect(actions, 'the link acted before the visitor confirmed').toEqual([]);

		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();
		await page.reload({ waitUntil: 'load' });
		await expect(page.getByRole('dialog', { name: 'Send this prompt?' })).toHaveCount(0);
		expect(actions, 'Cancel still let the link act').toEqual([]);
		expect(new URL(page.url()).pathname).toBe(CHAT_ENTRY);
	}
);

test(
	'confirming a crafted /chat link fetches its attachment and starts the conversation',
	{ tag: ['@preview-only', '@CUR-2644'] },
	async ({ page }) => {
		// The positive control: without it, a dialog whose Send did nothing would pass the test above.
		await page.route('**/chat/conversation/*', (route) =>
			route.request().method() === 'POST' ? route.abort() : route.fallback()
		);
		const actions = watchActions(page);

		const dialog = await openLink(page, `Confirmed deep link ${Date.now()}`);
		await expect(dialog).toBeVisible({ timeout: 20_000 });
		expect(actions).toEqual([]);

		await dialog.getByRole('button', { name: 'Send' }).click();
		await expect(page).toHaveURL(/\/chat\/conversation\/[^/?]+/, { timeout: 20_000 });
		expect(actions).toEqual(['GET /chat/api/fetch-url', 'POST /chat/conversation']);
	}
);
