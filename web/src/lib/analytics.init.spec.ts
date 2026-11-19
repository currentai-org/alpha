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
