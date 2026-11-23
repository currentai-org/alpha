// e2e-product: @chat
// e2e-area: @turn
// a phone that locks mid-answer is not a failed turn. The page's 8 s silence watchdog used to
// keep counting while the page was hidden and fire the moment it showed again, so a visitor who locked
// their phone for twenty seconds came back to a turn logged as `stale_connection` (or `ttft_timeout`).
// Hidden time no longer counts: the watchdog pauses while hidden and resumes with the rest of its window.
//
// The spec makes the answer stream go dark the way a locked phone's fetch does (nothing closes, nothing
// errors, nothing more arrives) and hides the page for longer than the window. `answer_holds_midway`
// sends one sentence and then holds the rest for twenty seconds, so the server is still writing when the
// page comes back and the follow route has something to finish. The turn's PostHog events are
// read off the wire and let through, so the run's `resumed_after_hidden` event is in PostHog too.
import type { Page, Request } from '@playwright/test';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import {
	captureIngest,
	letPostHogSeeTheHarness,
	type CapturedEvent
} from './helpers/posthogIngest';

const WATCHDOG_MS = 8_000;
const HIDDEN_MS = 10_000;

/** Wraps the answer stream's body so `window.__freezeAnswerStream()` stops it delivering for good, the
 *  way a locked phone's fetch goes dark: nothing closes and nothing errors, and the page's own cancel
 *  still ends it. Only the conversation POST's body is wrapped. Returns how many streams it wrapped. */
const WRAP_ANSWER_STREAM = () => {
	const realFetch = window.fetch.bind(window);
	let frozen = false;
	let wrapped = 0;
	(window as unknown as { __freezeAnswerStream: () => number }).__freezeAnswerStream = () => {
		frozen = true;
		return wrapped;
	};
	const never = () => new Promise<void>(() => {});
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
		wrapped += 1;
		const upstream = response.body.getReader();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (frozen) return never();
				try {
					const { done, value } = await upstream.read();
					if (frozen) return never();
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

/** Sets what the page reads as its visibility and tells it, as a lock or an app switch does. */
async function setPageHidden(page: Page, hidden: boolean) {
	await page.evaluate((h) => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => (h ? 'hidden' : 'visible')
		});
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
		document.dispatchEvent(new Event('visibilitychange'));
	}, hidden);
}

const isFollow = (request: Request) =>
	/\/conversation\/[a-f0-9]+\/generation\//.test(request.url());

/** The turn's terminal chat-health events, as the page sent them. */
const turnEvents = (events: CapturedEvent[]) =>
	events.filter((e) => e.event === 'response_received' || e.event === 'response_error');

async function startAnswer(page: Page) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, async () => {
		await welcome.getByRole('button', { name: /start chatting/i }).click();
	});
	await letPostHogSeeTheHarness(page);
	const events = await captureIngest(page, { forward: true });
	await installFaultInjectionHeader(page, 'answer_holds_midway');
	await page.addInitScript(WRAP_ANSWER_STREAM);
	const follows: number[] = [];
	page.on('request', (request) => {
		if (isFollow(request)) follows.push(Date.now());
	});
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
	await expect(stop, 'the answer finished before the spec could cut its stream').toBeVisible();
	return { reply, stop, events, follows };
}

async function freezeAnswerStream(page: Page) {
	const wrapped = await page.evaluate(() =>
		(window as unknown as { __freezeAnswerStream: () => number }).__freezeAnswerStream()
	);
	expect(wrapped, 'no answer stream was open to freeze, so the wrapper never saw the send').toBe(1);
}

test(
	'a page hidden mid-answer for longer than the watchdog comes back to the answer finishing, logged as resumed and not as a dead connection',
	{ tag: ['@C3', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'stream-follow': true });
		const { reply, stop, events, follows } = await startAnswer(page);

		await freezeAnswerStream(page);
		await setPageHidden(page, true);
		// Hidden and silent for longer than the window. Nothing may count it: no follow starts, no failure
		// shows, and the turn still reads as running. Watched for the whole hidden stretch, since absence of
		// a fire is the assertion.
		const hiddenUntil = Date.now() + HIDDEN_MS;
		while (Date.now() < hiddenUntil) {
			expect(follows, 'the watchdog fired while the page was hidden').toEqual([]);
			await expect(stop, 'the turn stopped reading as running while hidden').toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		await setPageHidden(page, false);

		await expect(reply, 'the answer never finished after the page came back').toContainText(
			/narrow river valley into a wide U shape/,
			{ timeout: 60_000 }
		);
		await expect(stop).toHaveCount(0, { timeout: 30_000 });
		await expect(reply.getByRole('alert')).toHaveCount(0);
		await expect(reply).not.toContainText(/No answer was produced/);
		// The connection was dead, so the page did resume through the follow route, once the visible rest
		// of the window had passed.
		expect(follows.length, 'the page never followed the turn after it came back').toBeGreaterThan(
			0
		);

		await expect
			.poll(
				() =>
					turnEvents(events).some(
						(e) =>
							e.event === 'response_received' &&
							e.properties?.resumed_after_hidden === true &&
							Number(e.properties?.hidden_ms) >= HIDDEN_MS
					),
				{
					message: `no response_received carrying resumed_after_hidden and hidden_ms ≥ ${HIDDEN_MS} was sent; sent: ${JSON.stringify(turnEvents(events).map((e) => e.properties))}`,
					timeout: 45_000
				}
			)
			.toBe(true);
		const deadLine = turnEvents(events).filter(
			(e) =>
				e.event === 'response_error' &&
				(e.properties?.reason === 'ttft_timeout' || e.properties?.reason === 'stale_connection')
		);
		expect(deadLine, 'the hidden stretch was logged as a dead connection').toEqual([]);
	}
);

test(
	'a page visible throughout whose answer goes silent still fires the watchdog at 8 s and logs a stale connection',
	{ tag: ['@C3', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'stream-follow': true });
		const { reply, stop, events, follows } = await startAnswer(page);

		await freezeAnswerStream(page);
		const frozenAt = Date.now();
		await expect
			.poll(() => follows.length, {
				message: 'the watchdog never fired on a visible page whose answer went silent',
				timeout: 30_000
			})
			.toBeGreaterThan(0);
		const firedAfter = follows[0] - frozenAt;
		// The watchdog was last armed by the keepalive just before the freeze, so the follow starts one
		// window later, plus the request settling. Well short of the window means hidden-time logic leaked
		// into a visible page; far past it means the window grew.
		expect(firedAfter, 'the watchdog fired before 8 s of visible silence').toBeGreaterThanOrEqual(
			WATCHDOG_MS - 1_000
		);
		expect(firedAfter, 'the watchdog took far longer than 8 s to fire').toBeLessThan(
			WATCHDOG_MS + 7_000
		);

		await expect(reply, 'the follow never finished the answer').toContainText(
			/narrow river valley into a wide U shape/,
			{ timeout: 60_000 }
		);
		await expect(stop).toHaveCount(0, { timeout: 30_000 });
		await expect
			.poll(
				() =>
					turnEvents(events).some(
						(e) =>
							e.event === 'response_error' &&
							e.properties?.reason === 'stale_connection' &&
							e.properties?.resumed_after_hidden === false
					),
				{
					message: `no response_error with reason stale_connection was sent; sent: ${JSON.stringify(turnEvents(events).map((e) => e.properties))}`,
					timeout: 45_000
				}
			)
			.toBe(true);
	}
);
