// e2e-product: @chat
// e2e-area: @turn
import { gunzipSync } from 'node:zlib';
import type { Page, Request } from '@playwright/test';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';

// An error thrown in a visitor's browser used to produce nothing anywhere. analytics.ts
// turns on posthog-js's `capture_exceptions`, which hooks `window.onerror` and
// `unhandledrejection` and sends a `$exception` event. This spec throws both kinds in the chat page
// and reads the `$exception` event off the wire.
//
// The ingest request is answered here and never reaches PostHog, so a scenario run does not open a
// probe issue in error tracking on every PR. What this proves is that the browser captures and
// sends the error, with stack frames. The frames point into minified chunks until source maps
// upload, and that needs POSTHOG_CLI_API_KEY (CUR-1510's other Done-when items).

type CapturedEvent = { event: string; properties?: Record<string, unknown> };
type ExceptionEntry = {
	type?: string;
	value?: string;
	stacktrace?: { frames?: unknown[] };
};

// posthog-js posts to `<api_host>/e/` (or `/i/v0/e/`), where api_host is the same-origin `/rs`
// proxy or us.i.posthog.com depending on PUBLIC_POSTHOG_HOST. Both are matched.
function isIngest(url: URL): boolean {
	const viaProxy = url.pathname.startsWith('/rs/');
	const direct = url.hostname.endsWith('.posthog.com');
	return (viaProxy || direct) && /\/(?:i\/v0\/)?e\/?$/.test(url.pathname);
}

// The body is gzip (`compression=gzip-js`), a `data=<base64>` form, or plain JSON, depending on
// what the browser supports; a batch is an array and a single capture is one object.
function decodeIngest(request: Request): CapturedEvent[] {
	const raw = request.postDataBuffer();
	if (!raw || raw.length === 0) return [];
	let text: string;
	if (raw[0] === 0x1f && raw[1] === 0x8b) {
		text = gunzipSync(raw).toString('utf8');
	} else {
		text = raw.toString('utf8');
		if (text.startsWith('data=')) {
			text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8');
		}
	}
	const parsed = JSON.parse(text) as CapturedEvent | CapturedEvent[] | { batch: CapturedEvent[] };
	if (Array.isArray(parsed)) return parsed;
	if ('batch' in parsed) return parsed.batch;
	return [parsed];
}

async function captureIngest(page: Page): Promise<CapturedEvent[]> {
	const events: CapturedEvent[] = [];
	await page.route(
		(url) => isIngest(url),
		async (route) => {
			try {
				events.push(...decodeIngest(route.request()));
			} catch (error) {
				// An undecodable body is recorded rather than thrown, so the assertion below names it.
				events.push({ event: '__undecodable__', properties: { error: String(error) } });
			}
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
		}
	);
	return events;
}

function exceptionFor(events: CapturedEvent[], marker: string): ExceptionEntry | undefined {
	for (const e of events) {
		if (e.event !== '$exception') continue;
		const list = (e.properties?.$exception_list ?? []) as ExceptionEntry[];
		const hit = list.find((x) => x.value?.includes(marker));
		if (hit) return hit;
	}
	return undefined;
}

test.describe('a browser error reaches PostHog as a $exception event (CUR-1510)', () => {
	test.beforeEach(async ({ page }) => {
		// posthog-js drops every event from a browser it takes for a bot, and it reads Playwright's
		// Chromium as one twice over: `navigator.webdriver` is true, and `userAgentData.brands` names
		// HeadlessChrome. Without this the page sends nothing at all, not even $pageview (no `/rs/e/`
		// requests until both were masked). The config's user agent is already
		// a plain Chrome string. A real visitor's browser sets neither, so this only removes the
		// harness, not a product behavior.
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
			Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
		});
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
	});

	test('an uncaught error thrown in the chat page is sent as a $exception with its message and stack frames', async ({
		page
	}) => {
		const events = await captureIngest(page);
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `cur-1510 uncaught probe ${Date.now()}`;
		// posthog-js loads its exception hook after init, so throw on each poll until one is caught;
		// every throw is answered locally above.
		await expect
			.poll(
				async () => {
					await page.evaluate((m) => {
						setTimeout(() => {
							throw new Error(m);
						}, 0);
					}, marker);
					return exceptionFor(events, marker) !== undefined;
				},
				{
					message: `no $exception carrying "${marker}" was sent; the capture hook is not running, or its request went somewhere isIngest does not match`,
					timeout: 45_000,
					intervals: [2_000]
				}
			)
			.toBe(true);

		const entry = exceptionFor(events, marker)!;
		expect(entry.type).toBe('Error');
		expect(
			entry.stacktrace?.frames?.length ?? 0,
			'the captured exception has no stack frames'
		).toBeGreaterThan(0);
	});

	// The browser's ResizeObserver loop warning is dropped before it is sent. Each attempt
	// throws the warning and then a real error; once the real one arrives the hook was live for the
	// warning thrown just before it, so its absence means the filter dropped it rather than the hook
	// missing it. Chrome reports the real warning through window.onerror with the same message, which
	// is all the filter reads.
	test('the ResizeObserver loop warning is not sent, while a real error thrown right after it is', async ({
		page
	}) => {
		const events = await captureIngest(page);
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `cur-3039 real error after the warning ${Date.now()}`;
		await expect
			.poll(
				async () => {
					await page.evaluate((m) => {
						setTimeout(() => {
							throw new Error('ResizeObserver loop completed with undelivered notifications.');
						}, 0);
						setTimeout(() => {
							throw new Error(m);
						}, 0);
					}, marker);
					return exceptionFor(events, marker) !== undefined;
				},
				{
					message: `no $exception carrying "${marker}" was sent, so this run says nothing about the filter`,
					timeout: 45_000,
					intervals: [2_000]
				}
			)
			.toBe(true);

		expect(
			exceptionFor(events, 'ResizeObserver loop'),
			'the ResizeObserver loop warning was sent to PostHog'
		).toBeUndefined();
	});

	test('an unhandled promise rejection in the chat page is sent as a $exception with its message', async ({
		page
	}) => {
		const events = await captureIngest(page);
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `cur-1510 rejection probe ${Date.now()}`;
		await expect
			.poll(
				async () => {
					await page.evaluate((m) => {
						void Promise.reject(new Error(m));
					}, marker);
					return exceptionFor(events, marker) !== undefined;
				},
				{
					message: `no $exception carrying "${marker}" was sent; the capture hook is not running, or its request went somewhere isIngest does not match`,
					timeout: 45_000,
					intervals: [2_000]
				}
			)
			.toBe(true);
	});
});
