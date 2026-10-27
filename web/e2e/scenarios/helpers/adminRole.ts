import postgres from 'postgres';
import type { Page } from '@playwright/test';
import { sslFor } from './db';
import { freshTestEmail, signInWithEmailOtp } from './signIn';

/** The staff roles `adminRoles.ts` defines (CUR-3990). */
export type StaffRole = 'operator' | 'editor' | 'admin';

/**
 * Sign a fresh `example.org` user in through the real OTP flow, then give it `role` in the
 * deployment's own database (CUR-3991).
 *
 * This replaces the shared admin password for specs: a PR preview has its own database and no admin
 * credential, so a spec that seeds its own role holder runs there instead of skipping. Better Auth
 * reads the user row on every request (no session cookie cache), so the role counts from the next
 * request on without signing in again. The address carries the run id, so the CI cleanup deletes the
 * account with the rest of the run's users.
 */
export async function signInWithRole(
	page: Page,
	databaseUrl: string,
	role: StaffRole
): Promise<string> {
	const email = freshTestEmail();
	await signInWithEmailOtp(page, databaseUrl, email, { skipPendingLabelCheck: true });
	const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
	try {
		const rows = await sql`update "user" set role = ${role} where email = ${email} returning id`;
		if (rows.length !== 1) throw new Error(`no Better Auth user row for ${email} to give ${role}`);
	} finally {
		await sql.end({ timeout: 5 });
	}
	return email;
}
