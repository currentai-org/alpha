// e2e-product: @chat
// e2e-area: @turn
// an answer whose connection drops picks up live where it left off. A phone that locks closes
// the answer stream cleanly while the server goes on writing. With `stream-follow` on, the page follows
// the turn through the generation follow route, so text written after the drop arrives while "Stop
// generating" is still showing, instead of waiting for the saved copy at the end.
// `answer_streams_slowly` sends one sentence, then one more every two seconds for about fourteen, so the
// stream is certainly mid-answer when the spec closes it and certainly still growing afterwards.
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';

/** Wraps the answer stream's body so `window.__closeAnswerStream()` ends it cleanly, the way iOS closes a
 *  suspended page's fetch. Only the conversation POST's body is wrapped. */
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

async function startDroppedAnswer(page: import('@playwright/test').Page) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await installFaultInjectionHeader(page, 'answer_streams_slowly');
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
	const stop = page.getByRole('button', { name: 'Stop generating' });
	await expect(
		stop,
		'the answer finished before the spec could close the stream, so nothing was cut off'
	).toBeVisible();
	const closed = await page.evaluate(() =>
		(window as unknown as { __closeAnswerStream: () => number }).__closeAnswerStream()
	);
	expect(closed, 'no answer stream was open to close, so the wrapper never saw the send').toBe(1);
	return { reply, stop };
}

test(
	'with stream-follow on, an answer whose stream closes halfway keeps growing live and finishes without a reload',
	{ tag: ['@C3', '@CUR-4716', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'stream-follow': true });
		const { reply, stop } = await startDroppedAnswer(page);

		// New text arrives after the drop while the turn still reads as running: the follow, not the
		// saved copy at the end, which only lands once Stop generating is gone.
		await expect(
			reply,
			'no new text arrived after the stream closed: the page is not following the turn'
		).toContainText(/Meltwater carries the loosened pieces/, { timeout: 30_000 });
		await expect(
			stop,
			'the turn stopped reading as running before the follow showed its text'
		).toBeVisible();

		await expect(reply, 'the follow never reached the end of the answer').toContainText(
			/deep U-shaped valley remains/,
			{ timeout: 60_000 }
		);
		await expect(stop).toHaveCount(0, { timeout: 30_000 });
		await expect(reply.getByRole('alert')).toHaveCount(0);
		await expect(page.locator('[data-message-type="user"]')).toHaveCount(1);
	}
);

test(
	'Stop during a follow ends the turn and nothing grows back',
	{ tag: ['@C3', '@CUR-4716', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'stream-follow': true });
		const { reply, stop } = await startDroppedAnswer(page);

		await expect(reply, 'the follow showed no new text before Stop').toContainText(
			/Meltwater carries the loosened pieces/,
			{ timeout: 30_000 }
		);
		await stop.click();
		await expect(stop).toHaveCount(0, { timeout: 30_000 });
		// The answer's own text, not the whole bubble: the "interrupted" notice and the provenance line
		// settle in after Stop and are meant to, so counting them reads a correct stop as growth.
		const answer = reply.locator('.prose');
		const answerText = async () => (await answer.allInnerTexts()).join('\n');
		const stopped = (await answerText()).length;

		// The server wrote for ten more seconds if it did not stop; nothing may appear past the stop point.
		// Absence of growth is the assertion, so it is watched for as long as the server would have kept writing.
		const watchUntil = Date.now() + 12_000;
		while (Date.now() < watchUntil) {
			expect((await answerText()).length, 'answer text grew back after Stop').toBe(stopped);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		await expect(reply).not.toContainText(/deep U-shaped valley remains/);
	}
);

test(
	'with stream-follow off, a stream that closes halfway never asks the follow route for the rest',
	{ tag: ['@C3', '@CUR-4716', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'stream-follow': false });
		const followRequests: string[] = [];
		page.on('request', (request) => {
			if (/\/conversation\/[a-f0-9]+\/generation\//.test(request.url())) {
				followRequests.push(request.url());
			}
		});
		await startDroppedAnswer(page);
		// Long enough for a follow to have started if the page were going to make one.
		const watchUntil = Date.now() + 10_000;
		while (Date.now() < watchUntil) {
			expect(followRequests, 'the page followed the generation with the flag off').toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
);
