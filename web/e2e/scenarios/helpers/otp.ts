// The working mechanism for this whole suite: read the real sign-in OTP straight out of the
// ephemeral Neon branch's own `verification` table. There is no bypass reachable on a deployed
// preview — betterAuth.ts's dev-log stub gates on SvelteKit's build-time `dev` (false in any
// production build, and a deployed preview is one) — so the code is genuinely emailed, and
// there is no inbox to read it from. Per the installed better-auth package
// (plugins/email-otp/index.mjs, utils.mjs): the project's emailOTP() config never overrides the
// plugin's `storeOTP: "plain"` default, so the row is written unhashed before
// sendVerificationOtp() ever resolves client-side.
//
// Raw `postgres`, not drizzle-orm — same pattern as the other ad hoc Neon-branch reads in this
// repo (web/scripts/verify-served-backends.mjs, web/scripts/clone-rag.mjs). This is one query;
// pulling in the app's typed schema for it is more machinery than the existing convention uses.
import postgres from 'postgres';
import { sslFor } from './db';

/** No code has been sent to this address yet: the one read failure the persona inbox reports as news. */
export class NoSignInCodeError extends Error {}

function signInOtpIdentifier(email: string): string {
	// Mirrors better-auth's own toOTPIdentifier (email-otp/utils.mjs) — not exported for external
	// use. The server lowercases the email before computing this (routes.mjs's sendVerificationOTP
	// endpoint does `ctx.body.email.toLowerCase()`), so a caller passing a mixed-case address would
	// silently miss its own row. freshTestEmail() is already all-lowercase; keep it that way.
	return `sign-in-otp-${email.toLowerCase()}`;
}

export async function readSignInOtp(databaseUrl: string, email: string): Promise<string> {
	const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
	try {
		const identifier = signInOtpIdentifier(email);
		// A short retry loop, not a single read — defensive margin against pool/replica latency, not
		// a requirement of the design (the write is already committed by the time the caller gets
		// here, since the app awaits createVerificationValue before returning from sendVerificationOTP).
		for (let attempt = 0; attempt < 10; attempt++) {
			const rows = await sql<{ value: string }[]>`
				select value from verification
				where identifier = ${identifier}
				order by created_at desc
				limit 1
			`;
			if (rows[0]) return rows[0].value.slice(0, 6); // "<otp>:<attempts>" — OTP is a fixed length 6
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new NoSignInCodeError(`no verification row for identifier ${identifier} after 5s`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

/** Ages the newest sign-in code for `email` past its expiry, so a spec can walk an expired code
 *  without waiting out the 600 s window (CUR-2793). Fails loud when there is no row to age, since a
 *  spec that "expired" nothing would then be testing a live code. */
export async function expireSignInOtp(databaseUrl: string, email: string): Promise<void> {
	const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 1 });
	try {
		const rows = await sql`
			update verification set expires_at = now() - interval '1 minute'
			where identifier = ${signInOtpIdentifier(email)}
			returning id
		`;
		if (rows.length === 0)
			throw new Error(`no verification row for ${signInOtpIdentifier(email)} to expire`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}
