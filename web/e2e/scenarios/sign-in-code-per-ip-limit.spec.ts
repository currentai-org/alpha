// e2e-product: @chat
// e2e-area: @auth
import postgres from 'postgres';
import { test, expect } from './helpers/test';
import { freshTestEmail } from './helpers/signIn';
import { sslFor } from './helpers/db';

// A signed-out script asking for sign-in codes in a loop is refused by the per-IP limit on the
// code-request path (3 a minute, times the shared-venue multiplier of 20, so 60). The count lives in
// the database rather than each serverless instance's memory, so a script that lands on a different
// instance each time still meets it. The requests carry no bypass header, and every address is on the
// reserved test domain, so no mail is sent and no email quota is spent.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const SEND_PATH = '/chat/api/auth/email-otp/send-verification-otp';
const PER_IP_LIMIT = 60;

test('a script requesting sign-in codes past the per-IP limit is refused, and the count is stored in the database', async ({
	request,
	baseURL
}) => {
	test.setTimeout(180_000);
	const origin = new URL(baseURL!).origin;
	let refusedAt = -1;
	const seen = new Map<number, number>();
	for (let i = 0; i <= PER_IP_LIMIT + 10; i++) {
		const res = await request.post(SEND_PATH, {
			data: { email: freshTestEmail(), type: 'sign-in' },
			headers: { origin }
		});
		seen.set(res.status(), (seen.get(res.status()) ?? 0) + 1);
		if (res.status() === 429) {
			refusedAt = i;
			break;
		}
	}
	expect(
		refusedAt,
		`${PER_IP_LIMIT + 11} code requests from one address were never refused (statuses ${JSON.stringify([...seen])}): the per-IP limit on sign-in codes is not applied`
	).toBeGreaterThanOrEqual(0);
	// Repeats run in parallel and share one count, so another repeat's requests can leave this one refused at once. An earlier repeat of this spec inside the same minute leaves a count behind, so the refusal may
	// come sooner than 60; it never comes later.
	expect(refusedAt).toBeLessThanOrEqual(PER_IP_LIMIT);

	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const rows = await sql<{ count: number }[]>`
				select count from rate_limit where key like ${'%' + 'email-otp/send-verification-otp'}
			`;
		expect(
			rows.length,
			'the refusal came from instance memory: no rate_limit row holds the count'
		).toBeGreaterThan(0);
	} finally {
		await sql.end({ timeout: 5 });
	}
});
