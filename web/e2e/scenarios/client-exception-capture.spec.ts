// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { startChattingPastWelcome } from './helpers/welcome';
import {
	captureIngest,
	letPostHogSeeTheHarness,
	type CapturedEvent
} from './helpers/posthogIngest';

// An error thrown in a visitor's browser used to produce nothing anywhere. analytics.ts
// turns on posthog-js's `capture_exceptions`, which hooks `window.onerror` and
// `unhandledrejection` and sends a `$exception` event. This spec throws both kinds in the chat page
// and reads the `$exception` event off the wire.
//
// The ingest request is answered here and never reaches PostHog, so a scenario run does not open a
// probe issue in error tracking on every PR. What this proves is that the browser captures and
// sends the error, with stack frames. The frames point into minified chunks until source maps
// upload, and that needs POSTHOG_CLI_API_KEY (the other Done-when items).

type ExceptionEntry = {
	type?: string;
	value?: string;
	stacktrace?: { frames?: unknown[] };
};

function exceptionFor(events: CapturedEvent[], marker: string): ExceptionEntry | undefined {
	for (const e of events) {
		if (e.event !== '$exception') continue;
		const list = (e.properties?.$exception_list ?? []) as ExceptionEntry[];
		const hit = list.find((x) => x.value?.includes(marker));
		if (hit) return hit;
	}
	return undefined;
}

test.describe('a browser error reaches PostHog as a $exception event', () => {
	test.beforeEach(async ({ page }) => {
		await letPostHogSeeTheHarness(page);
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
	});

	test('an uncaught error thrown in the chat page is sent as a $exception with its message and stack frames', async ({
		page
	}) => {
		const events = await captureIngest(page, { forward: false });
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `capture-probe uncaught ${Date.now()}`;
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
		const events = await captureIngest(page, { forward: false });
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `capture-probe real error after the warning ${Date.now()}`;
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
		const events = await captureIngest(page, { forward: false });
		await page.goto(chatEntry());
		await expect(page.getByLabel('Message AI Potluck')).toBeVisible({ timeout: 30_000 });

		const marker = `capture-probe rejection ${Date.now()}`;
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
