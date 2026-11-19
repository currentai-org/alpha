// e2e-product: @chat
// e2e-area: @turn
// the sibling of offline-mid-answer.spec.ts. A phone that locks, or a visitor who switches
// apps, closes the answer stream cleanly: the body read resolves `done`, nothing throws and no
// watchdog fires, so the page used to end the turn with half an answer while the server went on to
// finish and save the whole one. The browser stays online here, as it does when the phone wakes up.
// `answer_holds_midway` streams one sentence, holds the turn for 20 s, then sends the rest, so the
// stream is certainly mid-answer when the spec closes it and the server certainly finishes afterwards.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';

/** Wraps the answer stream's body so `window.__closeAnswerStream()` ends it cleanly, the way iOS
 *  closes a suspended page's fetch. Runs before the app's own code, so the app's `fetch` is the
 *  wrapped one. Only the conversation POST's body is wrapped. */
const WRAP_ANSWER_STREAM = () => {
	const realFetch = window.fetch.bind(window);
	const closes: Array<() => void> = [];
	(window as unknown as { __closeAnswerStream: () => number }).__closeAnswerStream = () => {
		for (const close of closes) close();
		return closes.length;
	};
	window.fetch = async (input, init) => {
		const response = await realFetch(input, init);
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase();
		if (
			method !== 'POST' ||
			!/\/conversation\/[a-f0-9]+$/.test(new URL(url, location.href).pathname) ||
			!response.body
		) {
			return response;
		}
		const upstream = response.body.getReader();
		let closed = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				closes.push(() => {
					closed = true;
					controller.close();
					void upstream.cancel().catch(() => {});
				});
			},
			async pull(controller) {
				try {
					const { done, value } = await upstream.read();
					if (closed) return;
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (err) {
					if (!closed) controller.error(err);
				}
			},
			cancel(reason) {
				return upstream.cancel(reason);
			}
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	};
};

test(
	'an answer whose stream closes cleanly halfway (a phone locking) is replaced by the full saved answer without a reload',
	{ tag: ['@C3', '@CUR-4714', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'answer_holds_midway');
		await page.addInitScript(WRAP_ANSWER_STREAM);
		await page.goto(chatEntry(), { waitUntil: 'commit' });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('How do glaciers carve valleys?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(reply, 'the first part of the answer never streamed in').toContainText(
			/grinding the rock beneath them/,
			{ timeout: 90_000 }
		);
		await expect(
			page.getByRole('button', { name: 'Stop generating' }),
			'the answer finished before the spec could close the stream, so nothing was cut off'
		).toBeVisible();
		const closed = await page.evaluate(() =>
			(window as unknown as { __closeAnswerStream: () => number }).__closeAnswerStream()
		);
		expect(closed, 'no answer stream was open to close, so the wrapper never saw the send').toBe(1);

		// The server holds 20 s, then finishes and saves. The page must pick that answer up on its own.
		await expect(
			reply,
			'the rest of the answer never arrived: the page stopped at the half it had when the stream closed'
		).toContainText(/wide U shape/, { timeout: 90_000 });
		await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
			timeout: 30_000
		});
		await expect(reply.getByRole('alert')).toHaveCount(0);
		await expect(page.locator('[data-message-type="user"]')).toHaveCount(1);
	}
);
