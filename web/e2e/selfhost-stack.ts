// What the specs that run against the composed self-host stack share (owui-migrate.spec.ts,
// selfhost-files.spec.ts): `docker compose` in selfhost/, a psql on the stack's database, and
// sign-in by email code read from that database.
//
// Sign-in: the stack has no OIDC or dev login. Email-code sign-in is the real route and its mail sender is
// not configured, but Better Auth writes the code to the `verification` table before it tries to send, so
// a spec requests a code through the real endpoint and reads it from the stack's database, the way
// scripts/staff-session.mjs does against a deployment. No auth code is added or bypassed.
//
// Environment: SELFHOST_DIR (default ../selfhost, relative to web/), SELFHOST_COMPOSE_PROFILE (default
// local; comma-separated for several), and COMPOSE_FILE from the job's environment.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startChattingPastWelcome } from './scenarios/helpers/welcome';

const selfhostDir = resolve(process.env.SELFHOST_DIR ?? '../selfhost');
const profiles = (process.env.SELFHOST_COMPOSE_PROFILE ?? 'local')
	.split(',')
	.map((p) => p.trim())
	.filter(Boolean)
	.flatMap((p) => ['--profile', p]);

/** `docker compose` in the stack's directory, with COMPOSE_FILE from the job's environment. */
export function compose(
	args: string[],
	opts: { input?: string; env?: Record<string, string> } = {}
): string {
	const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
	const [sub, ...rest] = args;
	const withEnv = sub === 'exec' ? [sub, '-T', ...envArgs, ...rest] : args;
	return execFileSync('docker', ['compose', ...profiles, ...withEnv], {
		cwd: selfhostDir,
		input: opts.input,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit']
	});
}

/** psql on one of the stack's databases, statements on stdin, unaligned tuples out. */
export const psql = (database: string, input: string) =>
	compose(['exec', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'alpha', '-d', database, '-qAt'], {
		input
	});

/** The sign-in code Better Auth stored for `email`; the row is "<code>:<attempts>". */
async function readSignInCode(email: string): Promise<string> {
	const identifier = `sign-in-otp-${email.toLowerCase()}`;
	for (let attempt = 0; attempt < 20; attempt++) {
		const value = psql(
			'alpha',
			`select value from verification where identifier = '${identifier}' order by created_at desc limit 1;`
		).trim();
		if (value) return value.slice(0, 6);
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`no sign-in code reached the stack's verification table for ${email}`);
}

/** Signs `email` in through the real email-code routes; a new address makes a new account. */
export async function signInByEmailCode(
	request: APIRequestContext,
	base: string,
	email: string
): Promise<void> {
	const headers = { 'Content-Type': 'application/json', Origin: base };
	const sent = await request.post('/chat/api/auth/email-otp/send-verification-otp', {
		headers,
		data: { email, type: 'sign-in' }
	});
	expect(sent.status(), 'the code request is accepted').toBe(200);
	const signedIn = await request.post('/chat/api/auth/sign-in/email-otp', {
		headers,
		data: { email, otp: await readSignInCode(email) }
	});
	expect(signedIn.status(), `the code signs ${email} in`).toBe(200);
	const session = await (await request.get('/chat/api/auth/get-session')).json();
	expect(session?.user?.email, 'the session is the account the code was sent to').toBe(email);
}

/** Answers the "Welcome to Alpha" dialog whenever it covers the page. */
export async function dismissWelcome(page: Page) {
	const welcome = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcome, () => startChattingPastWelcome(welcome));
}
