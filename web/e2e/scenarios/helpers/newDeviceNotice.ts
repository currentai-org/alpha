// The new-device sign-in email, read the way otp.ts reads a sign-in code. An example.org
// address has no inbox, so newDeviceNotice.ts writes what it would have sent into the branch's
// `verification` table under `new-device-notice-<email>` instead of calling Resend.
import postgres from 'postgres';
import { sslFor } from './db';

export type NewDeviceNotice = { subject: string; text: string };

/** The newest notice sent to `email`, or null when none arrives within `waitMs`. The notice is sent
 *  in the background after the sign-in response, so a short poll covers the gap. */
export async function readNewDeviceNotice(
	databaseUrl: string,
	email: string,
	waitMs = 10_000
): Promise<NewDeviceNotice | null> {
	const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
	try {
		const identifier = `new-device-notice-${email.toLowerCase()}`;
		const deadline = Date.now() + waitMs;
		for (;;) {
			const rows = await sql<{ value: string }[]>`
				select value from verification
				where identifier = ${identifier}
				order by created_at desc
				limit 1
			`;
			if (rows[0]) return JSON.parse(rows[0].value) as NewDeviceNotice;
			if (Date.now() >= deadline) return null;
			await new Promise((r) => setTimeout(r, 500));
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}
