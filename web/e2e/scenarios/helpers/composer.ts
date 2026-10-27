import { expect, type Page, type Response } from '@playwright/test';

// Svelte 5 stores an element's delegated handlers (keydown, input) under a `Symbol('events')` key
// when it hydrates (svelte's `internal/client/dom/elements/events.js`), so the composer carrying
// one means the app has taken the box over. /api/warm is no signal: the composer sends it from
// `oninput`, and a keystroke can land before hydration.
//
// A spec that goes to a chat page with `waitUntil: 'commit'` and presses Enter at once may press it
// on the server-rendered box before any keydown handler exists, which would drop the send. That is
// the leading guess for tool-round-retry.spec.ts timing out on /conversation/<id> (CUR-3345), not
// an established cause; `sendOpensConversation` below reports enough to settle it next time.
const composerIsHydrated = () => {
	const box = document.querySelector('textarea[aria-label="Message AI Potluck"]');
	return !!box && Object.getOwnPropertySymbols(box).some((key) => key.description === 'events');
};

export async function composerHydrated(
	page: Page,
	{ timeout }: { timeout: number } = { timeout: 60_000 }
): Promise<void> {
	await page.waitForFunction(composerIsHydrated, undefined, { timeout });
}

/**
 * Presses Enter in the composer and waits for the new conversation's URL. When it never comes, the
 * error says which of the candidate causes it was: still on the entry page with the text in the box
 * and no app behind it (a pre-hydration Enter), the create request refused, or no request at all.
 */
export async function sendOpensConversation(
	page: Page,
	{ timeout }: { timeout: number } = { timeout: 30_000 }
): Promise<string> {
	const composer = page.getByLabel('Message AI Potluck');
	let created = 'no POST /chat/conversation was seen';
	const onResponse = (res: Response) => {
		const url = new URL(res.url());
		if (res.request().method() === 'POST' && /\/chat\/conversation\/?$/.test(url.pathname))
			created = `POST /chat/conversation answered ${res.status()}`;
	};
	page.on('response', onResponse);
	try {
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout });
	} catch (err) {
		const left = await composer.inputValue().catch(() => '(composer gone)');
		const hydrated = await page.evaluate(composerIsHydrated).catch(() => false);
		throw new Error(
			`the send never opened a conversation: still on ${page.url()}, ${created}, ` +
				`composer ${hydrated ? 'hydrated' : 'NOT hydrated'}, holding ${left.length} chars`,
			{ cause: err }
		);
	} finally {
		page.off('response', onResponse);
	}
	const id = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!id) throw new Error(`could not read a conversation id out of ${page.url()}`);
	return id;
}

/**
 * Pastes `paste` into the composer, waits for it to become a "Pasted Content" chip, then types
 * `question` and sends. A paste below the chip threshold would go out as typed text, so a spec that
 * names a message size checks the chip before relying on it.
 */
export async function pasteAndSend(page: Page, paste: string, question: string): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.evaluate((el, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		el.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
		);
	}, paste);
	await expect(
		page.getByText('Pasted Content').first(),
		'the paste did not become a chip, so the message is not the size this test is named for'
	).toBeVisible({ timeout: 10_000 });
	await composer.fill(question);
	await composer.press('Enter');
}
