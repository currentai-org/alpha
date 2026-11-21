// with no host configured, posthog-js talks to the same-origin /rs proxy, never straight to
// a PostHog cloud host, so a deployment's analytics follow its own POSTHOG_INGEST_HOST.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test'
}));
const init = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { init } }));

beforeEach(() => {
	init.mockClear();
	vi.resetModules(); // initAnalytics runs once per module instance
});

describe('initAnalytics — the PostHog API host', () => {
	it('defaults to the same-origin /rs proxy', async () => {
		const { initAnalytics } = await import('./analytics');
		initAnalytics('phc_x', undefined);
		expect(init).toHaveBeenCalledTimes(1);
		expect(init.mock.calls[0]![1]).toMatchObject({ api_host: '/rs' });
	});

	it('uses PUBLIC_POSTHOG_HOST and the UI host when given', async () => {
		const { initAnalytics } = await import('./analytics');
		initAnalytics('phc_x', 'https://eu.i.posthog.com', 'https://eu.posthog.com');
		expect(init.mock.calls[0]![1]).toMatchObject({
			api_host: 'https://eu.i.posthog.com',
			ui_host: 'https://eu.posthog.com'
		});
	});
});

// a region move brings a new project token, and posthog-js keys its storage by token, so a
// returning visitor keeps their old distinct_id only if the new init is bootstrapped with it.
describe('legacyDistinctId — a returning visitor keeps their id across a project token change', () => {
	const OLD = 'phc_old';
	const NEW = 'phc_new';
	const cookieFor = (token: string, id: string) =>
		`other=1; ph_${token}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: id, $device_id: id }))}`;
	const store = (cookie: string, local: Record<string, string> = {}) => ({
		cookie,
		getItem: (name: string) => local[name] ?? null
	});

	it('reads the old token cookie when nothing is stored under the new token', async () => {
		const { legacyDistinctId } = await import('./analytics');
		expect(legacyDistinctId(NEW, OLD, store(cookieFor(OLD, 'visitor-1')))).toBe('visitor-1');
	});

	it('falls back to the old token localStorage entry', async () => {
		const { legacyDistinctId } = await import('./analytics');
		const local = { [`ph_${OLD}_posthog`]: JSON.stringify({ distinct_id: 'visitor-2' }) };
		expect(legacyDistinctId(NEW, OLD, store('', local))).toBe('visitor-2');
	});

	it('leaves a browser alone once the new token has storage of its own', async () => {
		const { legacyDistinctId } = await import('./analytics');
		const cookie = `${cookieFor(OLD, 'visitor-1')}; ${cookieFor(NEW, 'visitor-new').replace('other=1; ', '')}`;
		expect(legacyDistinctId(NEW, OLD, store(cookie))).toBeUndefined();
	});

	it('does nothing with no legacy key, or one equal to the current key', async () => {
		const { legacyDistinctId } = await import('./analytics');
		const s = store(cookieFor(OLD, 'visitor-1'));
		expect(legacyDistinctId(NEW, undefined, s)).toBeUndefined();
		expect(legacyDistinctId(NEW, '', s)).toBeUndefined();
		expect(legacyDistinctId(OLD, OLD, s)).toBeUndefined();
	});

	it('ignores an unreadable cookie', async () => {
		const { legacyDistinctId } = await import('./analytics');
		expect(legacyDistinctId(NEW, OLD, store(`ph_${OLD}_posthog=%7Bnot-json`))).toBeUndefined();
	});

	it('initAnalytics passes the old id as bootstrap.distinctID, and nothing without a legacy key', async () => {
		vi.stubGlobal('document', {
			cookie: `ph_${OLD}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: 'visitor-3' }))}`
		});
		try {
			let { initAnalytics } = await import('./analytics');
			initAnalytics(NEW, undefined, undefined, OLD);
			expect(init.mock.calls[0]![1]).toMatchObject({ bootstrap: { distinctID: 'visitor-3' } });

			vi.resetModules();
			({ initAnalytics } = await import('./analytics'));
			initAnalytics(NEW, undefined);
			expect(init.mock.calls[1]![1]).not.toHaveProperty('bootstrap');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
