import { describe, it, expect } from 'vitest';
import {
	hrefToClickEvent,
	detectSource,
	internalTrafficProps,
	isBrowserNoise,
	scrubRouteIds
} from './analytics';

// Only the pure decision logic is worth unit coverage — the rest of analytics.ts is thin
// delegation to posthog-js. The substring matching in hrefToClickEvent is the real risk
// (a false match silently mis-attributes clicks), so pin its edges.

describe('hrefToClickEvent', () => {
	it('maps known destinations (real paths, full URLs, and CMS destination keys)', () => {
		expect(hrefToClickEvent('/chat')).toBe('click_to_chat');
		expect(hrefToClickEvent('chat')).toBe('click_to_chat');
		expect(hrefToClickEvent('https://www.aipotluck.org/chat')).toBe('click_to_chat');
		// chat's own host counts as chat once its links drop the /chat path. (CUR-4448)
		expect(hrefToClickEvent('https://alpha.aipotluck.org/')).toBe('click_to_chat');
		expect(hrefToClickEvent('/map')).toBe('click_to_map');
		expect(hrefToClickEvent('map')).toBe('click_to_map');
		expect(hrefToClickEvent('/contribute')).toBe('click_to_contribute');
		expect(hrefToClickEvent('/about')).toBe('click_to_about');
		// Wired ahead of the UI: fires the moment a /partners link exists.
		expect(hrefToClickEvent('/partners')).toBe('click_to_partners');
	});

	it('does not false-match on paths that merely contain a keyword substring', () => {
		expect(hrefToClickEvent('/roadmap')).toBeNull(); // contains "map", not "/map"
		expect(hrefToClickEvent('/faqs')).toBeNull();
		expect(hrefToClickEvent('/privacy-notice')).toBeNull();
		expect(hrefToClickEvent('/terms-of-service')).toBeNull();
	});

	it('returns null for empty/missing hrefs', () => {
		expect(hrefToClickEvent(undefined)).toBeNull();
		expect(hrefToClickEvent(null)).toBeNull();
		expect(hrefToClickEvent('')).toBeNull();
		expect(hrefToClickEvent('/')).toBeNull();
	});
});

describe('detectSource (the custom `source` super-property on $pageview)', () => {
	const source = (u: string) => detectSource(new URL(u));

	it('honours an explicit source/ref param', () => {
		expect(source('https://x/?source=qr_code')).toBe('qr_code');
		expect(source('https://x/?ref=partner-deck')).toBe('partner-deck');
	});

	it('detects QR arrivals from utm params (case-insensitive)', () => {
		expect(source('https://x/?utm_medium=qr')).toBe('qr_code');
		expect(source('https://x/?utm_source=QRcode')).toBe('qr_code');
	});

	it('falls back to direct with no params or referrer', () => {
		expect(source('https://x/')).toBe('direct');
	});
});

describe('internalTrafficProps (?ph_test → internal / tester markers, CUR-121)', () => {
	it('is null for a normal remote visitor', () => {
		expect(internalTrafficProps('www.aipotluck.org', '')).toBeNull();
		expect(internalTrafficProps('www.aipotluck.org', '?foo=bar')).toBeNull();
	});

	it('marks localhost internal, with NO tester name', () => {
		expect(internalTrafficProps('localhost', '')).toEqual({ is_internal_test: true });
		expect(internalTrafficProps('127.0.0.1', '')).toEqual({ is_internal_test: true });
	});

	it('?ph_test=1 is the plain internal marker, still no tester name', () => {
		expect(internalTrafficProps('www.aipotluck.org', '?ph_test=1')).toEqual({
			is_internal_test: true
		});
	});

	it('?ph_test=<label> tags the browser, so two internal sessions can be told apart', () => {
		expect(internalTrafficProps('www.aipotluck.org', '?ph_test=alpha')).toEqual({
			is_internal_test: true,
			tester: 'alpha'
		});
		expect(internalTrafficProps('develop.aipotluck.org', '?ph_test=bravo&x=1')).toEqual({
			is_internal_test: true,
			tester: 'bravo'
		});
	});
});

describe('scrubRouteIds (CUR-2606: PostHog events carry no conversation id)', () => {
	it('replaces the id in every URL-shaped property with :id, so an event links to no conversation', () => {
		const out = scrubRouteIds({
			event: '$pageleave',
			properties: {
				$current_url: 'https://www.aipotluck.org/chat/conversation/0123456789abcdef01234567?x=1',
				$pathname: '/chat/conversation/0123456789abcdef01234567',
				$prev_pageview_pathname: '/chat/admin/reports/0123456789abcdef01234567',
				$referrer: 'https://www.aipotluck.org/chat/workspace/accept/inv_123#top',
				turn_number: 3
			},
			$set_once: { $initial_current_url: 'https://www.aipotluck.org/chat/conversation/abc' }
		});
		expect(out.properties).toEqual({
			$current_url: 'https://www.aipotluck.org/chat/conversation/:id?x=1',
			$pathname: '/chat/conversation/:id',
			$prev_pageview_pathname: '/chat/admin/reports/:id',
			$referrer: 'https://www.aipotluck.org/chat/workspace/accept/:id#top',
			turn_number: 3
		});
		expect(out.$set_once).toEqual({
			$initial_current_url: 'https://www.aipotluck.org/chat/conversation/:id'
		});
		expect(out.event).toBe('$pageleave');
	});

	it('replaces the id inside nested objects and arrays, where $web_vitals keeps its own URLs', () => {
		const url = 'https://develop.aipotluck.org/chat/conversation/0123456789abcdef01234567?x=1';
		const out = scrubRouteIds({
			properties: {
				$web_vitals_FCP_event: { $current_url: url, navigationURL: url, delta: 316, entries: [url] }
			}
		});
		const scrubbed = 'https://develop.aipotluck.org/chat/conversation/:id?x=1';
		expect(out.properties).toEqual({
			$web_vitals_FCP_event: {
				$current_url: scrubbed,
				navigationURL: scrubbed,
				delta: 316,
				entries: [scrubbed]
			}
		});
	});

	it('leaves pages with no id untouched, and a root-form route shape that is not where a URL path begins', () => {
		const props = {
			$pathname: '/chat',
			$current_url: 'https://www.aipotluck.org/map',
			other: 'see /conversation/x',
			deeper: 'https://example.com/docs/conversation/x'
		};
		expect(scrubRouteIds({ properties: props }).properties).toEqual(props);
	});

	// On the chat surface the same routes live at the root, and a site event's $referrer can
	// name one from alpha, so the root form is scrubbed on both surfaces. A privacy guard: no
	// conversation id may reach PostHog whichever surface served the page. (CUR-4448)
	it("replaces the id in the chat surface's root-form URLs too (/conversation/<id> with no /chat)", () => {
		const out = scrubRouteIds({
			properties: {
				$current_url: 'https://alpha.aipotluck.org/conversation/0123456789abcdef01234567?x=1',
				$pathname: '/conversation/0123456789abcdef01234567',
				$prev_pageview_pathname: '/admin/reports/0123456789abcdef01234567',
				$referrer: 'https://alpha-develop.aipotluck.org/workspace/accept/inv_123#top',
				nested: { navigationURL: 'http://localhost:5173/conversation/abc/output/a.mp4' }
			}
		});
		expect(out.properties).toEqual({
			$current_url: 'https://alpha.aipotluck.org/conversation/:id?x=1',
			$pathname: '/conversation/:id',
			$prev_pageview_pathname: '/admin/reports/:id',
			$referrer: 'https://alpha-develop.aipotluck.org/workspace/accept/:id#top',
			nested: { navigationURL: 'http://localhost:5173/conversation/:id/output/a.mp4' }
		});
	});
});

describe('isBrowserNoise (CUR-3039: the ResizeObserver loop warning is never sent)', () => {
	const exception = (...values: string[]) => ({
		event: '$exception',
		properties: { $exception_list: values.map((value) => ({ type: 'Error', value })) }
	});

	it('drops an exception whose only entry is the ResizeObserver loop warning, in either wording', () => {
		expect(
			isBrowserNoise(exception('ResizeObserver loop completed with undelivered notifications.'))
		).toBe(true);
		expect(isBrowserNoise(exception('ResizeObserver loop limit exceeded'))).toBe(true);
	});

	it('keeps an exception that carries a real error alongside the warning', () => {
		expect(
			isBrowserNoise(
				exception(
					'ResizeObserver loop completed with undelivered notifications.',
					"Cannot read properties of undefined (reading 'id')"
				)
			)
		).toBe(false);
	});

	it('keeps an ordinary error, one that only mentions ResizeObserver, and an empty list', () => {
		expect(isBrowserNoise(exception('Failed to fetch dynamically imported module'))).toBe(false);
		expect(isBrowserNoise(exception('our ResizeObserver loop threw'))).toBe(false);
		expect(isBrowserNoise(exception())).toBe(false);
	});

	it('never drops an event that is not an exception', () => {
		expect(
			isBrowserNoise({
				event: '$pageview',
				properties: {
					$exception_list: [{ value: 'ResizeObserver loop limit exceeded' }]
				}
			})
		).toBe(false);
	});
});
