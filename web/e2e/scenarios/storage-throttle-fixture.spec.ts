// e2e-product: @chat
// e2e-area: @storage
import { test, expect, request as playwrightRequest } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { faultInjectionHeaders } from './helpers/faultInjection';
import { failIfStorageThrottled } from './helpers/storageThrottle';

// failIfStorageThrottled is what every storage spec calls before it polls the bucket, so a throttled
// shared token fails the spec at once, naming the throttle, instead of timing out as a wrong answer.
// This drives the fixture itself: a request context carrying the
// `storage_hub_rate_limited` fault gets the listing's busy 503, and the fixture, given that context,
// fails within seconds with the throttle message. The real shared token is never spent on purpose.
test(
	'failIfStorageThrottled fails at once, naming the throttle, when the storage listing answers the busy 503',
	{ tag: ['@preview-only', '@A3'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInAsFreshUser(page);

		const throttled = await playwrightRequest.newContext({
			baseURL,
			storageState: await context.storageState(),
			extraHTTPHeaders: faultInjectionHeaders('storage_hub_rate_limited')
		});
		try {
			const listing = await throttled.get('/chat/api/storage');
			expect(listing.status(), 'the fault did not make the listing answer busy').toBe(503);
			expect(Number(listing.headers()['retry-after'])).toBeGreaterThan(0);

			const started = Date.now();
			const outcome = await failIfStorageThrottled({ request: throttled }).then(
				() => 'passed',
				(err: Error) => err.message
			);
			expect(outcome, 'the fixture let a throttled listing through').toContain(
				'throttling the shared storage token'
			);
			expect(outcome).toContain('infrastructure, not this change');
			expect(Date.now() - started, 'the fixture waited instead of failing at once').toBeLessThan(
				10_000
			);

			// Without the fault the same account's listing is not busy, and the fixture lets it through.
			await failIfStorageThrottled(page);
		} finally {
			await throttled.dispose();
		}
	}
);
