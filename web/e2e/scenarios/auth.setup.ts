import { test as setup, expect } from '@playwright/test';
import { testAuthHelpers } from '../testAuth';
import { freshTestEmail } from './helpers/signIn';

// The specs that sign in through helpers/session.ts depend on this project. It proves once,
// before any of them runs, that the deployment under test accepts a session minted by the test-only
// instance (e2e/testAuth.ts). A wrong BETTER_AUTH_SECRET, a cookie prefix that no longer matches
// betterAuth.ts, or the wrong database all fail here with that named, instead of as a signed-out page
// deep inside some unrelated spec.
//
// `/chat/api/user` answers 401 unless the app itself resolved a person from the cookie, so this checks
// the whole chain the specs rely on: cookie name, signature, session row, and auth.ts's bridge.
setup(
	'the preview accepts a session minted by the test-only auth instance',
	async ({ context, baseURL }) => {
		const test = await testAuthHelpers();
		const email = freshTestEmail();
		const user = test.createUser({ email });
		user.name = '';
		await test.saveUser(user);
		try {
			await context.addCookies(await test.getCookies({ userId: user.id }));
			const res = await context.request.get('/chat/api/user');
			const body = (await res.json().catch(() => ({}))) as { email?: string; message?: string };
			expect(
				res.status(),
				`auth setup: ${baseURL} did not accept a session minted by e2e/testAuth.ts (/chat/api/user answered ${res.status()}${body.message ? `, "${body.message}"` : ''}). ` +
					"Check that BETTER_AUTH_SECRET is the preview's own value (Doppler `preview`), that SCENARIO_DATABASE_URL is the database this deployment reads, and that testAuth.ts's cookie prefix still matches computeSessionCookieScope in betterAuth.ts."
			).toBe(200);
			expect(body.email, 'auth setup: /chat/api/user answered for a different person').toBe(email);
		} finally {
			await test.deleteUser(user.id);
		}
	}
);
