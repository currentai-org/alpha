// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';

// A release condition on a person property reaches a signed-in account and not an anonymous
// visitor. `account-rollout-probe` is conditioned in PostHog on env = preview AND email matching
// `@example\.org$`, the domain every e2e account has (helpers/signIn.ts freshTestEmail), and when it is on
// for a request the server sets this header. No fuzz_override here: the value has to come from PostHog.
const PROBE_HEADER = 'x-account-rollout-probe';

test(
	'a team-domain account gets a flag conditioned on its email domain, and an anonymous visitor does not',
	{ tag: ['@preview-only', '@CUR-2463'] },
	async ({ page, request }) => {
		const anonymous = await request.get('/chat');
		expect(anonymous.ok(), 'the anonymous /chat request itself failed').toBe(true);
		expect(anonymous.headers()[PROBE_HEADER]).toBeUndefined();

		await signInAsFreshUser(page);
		const signedIn = await page.goto('/chat');
		expect(signedIn, 'no response for the signed-in /chat navigation').not.toBeNull();
		expect(
			signedIn!.headers()[PROBE_HEADER],
			'the probe flag did not reach the signed-in account: per-account evaluation is not in the path, or the PostHog condition is missing'
		).toBe('on');
	}
);
