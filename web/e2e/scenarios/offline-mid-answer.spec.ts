// e2e-product: @chat
// e2e-area: @turn
// Journey C3 (docs/journeys/c3-when-a-reply-cant-come.md), row 9 (CUR-2805): the visitor's own
// connection drops while an answer is streaming. Every other C3 row injects its failure on the server,
// so the browser stays online; this one takes the browser offline mid-answer, then brings it back.
// Preview-only like the rest of C3. `answer_holds_midway` streams one sentence and holds the turn open,
// because on preview a real model's answer often reaches the page in one burst at its end.
//
// `context.setOffline` blocks new requests but leaves a response that is already streaming open:
// the turn keeps streaming after it and finishes when the hold ends. So the spec also
// breaks the open answer stream itself, the way a dropped connection does in Chromium: the body read
// rejects with `TypeError: network error`. Only the conversation POST's body is wrapped.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { journeyStep } from './helpers/journeyStep';

const BROWSER_NETWORK_TEXT = /network error|Failed to fetch|ERR_INTERNET_DISCONNECTED/i;

/** Wraps the answer stream's body so `window.__dropAnswerStream()` fails its next read as a lost
 *  connection does. Runs before the app's own code, so the app's `fetch` is the wrapped one. */
const WRAP_ANSWER_STREAM = () => {
	const realFetch = window.fetch.bind(window);
	const drops: Array<() => void> = [];
	(window as unknown as { __dropAnswerStream: () => number }).__dropAnswerStream = () => {
		for (const drop of drops) drop();
		return drops.length;
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
		let cut: ((err: Error) => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				cut = (err) => {
					controller.error(err);
					void upstream.cancel().catch(() => {});
				};
				drops.push(() => cut?.(new TypeError('network error')));
			},
			async pull(controller) {
				try {
					const { done, value } = await upstream.read();
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (err) {
					controller.error(err);
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
	'an answer cut off by the visitor going offline says their connection dropped, and a reload recovers the chat',
	{ tag: ['@C3', '@CUR-2805', '@preview-only'] },
	async ({ page, context }) => {
		test.setTimeout(180_000);
		const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcome, async () => {
			await welcome.getByRole('button', { name: /start chatting/i }).click();
		});
		await installFaultInjectionHeader(page, 'answer_holds_midway');
		await page.addInitScript(WRAP_ANSWER_STREAM);
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const question = 'How do glaciers carve valleys?';

		await journeyStep(page, 'C3', 9, async () => {
			const composer = page.getByLabel('Message AI Potluck');
			await composer.click({ timeout: 30_000 });
			await composer.fill(question);
			await composer.press('Enter');
			await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

			const reply = page.locator('[data-message-role="assistant"]').last();
			await expect(reply, 'the first part of the answer never streamed in').toContainText(
				/grinding the rock beneath them/,
				{ timeout: 90_000 }
			);
			await expect(
				page.getByRole('button', { name: 'Stop generating' }),
				'the answer finished before the spec could go offline, so nothing was cut off'
			).toBeVisible();
			await context.setOffline(true);
			const dropped = await page.evaluate(() =>
				(window as unknown as { __dropAnswerStream: () => number }).__dropAnswerStream()
			);
			expect(dropped, 'no answer stream was open to drop, so the wrapper never saw the send').toBe(
				1
			);

			const notice = reply.getByRole('alert');
			await expect(
				notice,
				'going offline mid-answer put no notice in the turn; the browser error may have gone to a toast instead'
			).toContainText(/connection dropped/i, { timeout: 30_000 });
			await expect(notice).not.toContainText(BROWSER_NETWORK_TEXT);
			await expect(notice).not.toContainText(/too many messages|busy/i);
			await expect(page.getByText(BROWSER_NETWORK_TEXT)).toHaveCount(0);
			await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();

			await context.setOffline(false);
			await page.reload();
			await expect(page.locator('[data-message-type="user"]')).toHaveCount(1, {
				timeout: 30_000
			});
			await expect(page.locator('[data-message-type="user"]')).toContainText(question);
			// The server keeps generating when the client drops, so the reload holds either the finished
			// answer or, if the turn did not save, one Retry. Two Retries, or none on an empty turn, is
			// the broken state.
			const after = page.locator('[data-message-role="assistant"]').last();
			await expect(async () => {
				const retries = await after.getByRole('button', { name: 'Retry' }).count();
				const text = (await after.innerText()).trim();
				expect(retries, 'more than one Retry on the recovered turn').toBeLessThanOrEqual(1);
				expect(
					retries === 1 || /\w{4,}/.test(text),
					'the recovered turn shows neither an answer nor a Retry'
				).toBe(true);
				await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
			}).toPass({ timeout: 90_000 });
		});
	}
);
