// Reading the events the page sends to PostHog, off the wire.
import { gunzipSync } from 'node:zlib';
import type { Page, Request } from '@playwright/test';

export type CapturedEvent = { event: string; properties?: Record<string, unknown> };

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

/**
 * Collects every event the page sends to PostHog.
 *
 * @remarks `forward: false` answers each ingest request here so it never reaches PostHog (a probe
 * that would otherwise open an error-tracking issue on every run); `forward: true` lets it through,
 * so the run's events can be read in PostHog afterwards.
 */
export async function captureIngest(
	page: Page,
	{ forward }: { forward: boolean }
): Promise<CapturedEvent[]> {
	const events: CapturedEvent[] = [];
	await page.route(
		(url) => isIngest(url),
		async (route) => {
			try {
				events.push(...decodeIngest(route.request()));
			} catch (error) {
				// An undecodable body is recorded rather than thrown, so the assertion that reads it names it.
				events.push({ event: '__undecodable__', properties: { error: String(error) } });
			}
			if (forward) await route.continue();
			else
				await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
		}
	);
	return events;
}

/**
 * posthog-js drops every event from a browser it takes for a bot, and it reads Playwright's Chromium
 * as one twice over: `navigator.webdriver` is true, and `userAgentData.brands` names HeadlessChrome.
 * Without this the page sends nothing at all, not even $pageview (zero `/rs/e/`
 * requests until both were masked). The config's user agent is already a plain Chrome string. A real
 * visitor's browser sets neither, so this only removes the harness, not a product behavior.
 */
export async function letPostHogSeeTheHarness(page: Page): Promise<void> {
	await page.addInitScript(() => {
		Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
		Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
	});
}
