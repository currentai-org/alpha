// A test-only Better Auth instance, so a spec that needs a signed-in person can have one
// without walking the email-code sign-in screen (CUR-2184). Better Auth's own guidance for its test-utils plugin
// (https://www.better-auth.com/docs/plugins/test-utils): keep `testUtils()` in a separate test-only
// instance and never in the production config. Nothing under src/ imports this file.
//
// A session cookie this instance mints is only accepted by the deployment under test if both sign it
// and name it the same way. The pieces that have to agree with src/lib/chat/server/betterAuth.ts:
//   - `secret`: the preview's BETTER_AUTH_SECRET (one preview-wide value).
//   - the cookie name: `advanced.cookiePrefix` below, plus the `__Secure-` prefix Better Auth adds on
//     an https `baseURL`. Every non-production deployment uses "aip-preview"
//     (computeSessionCookieScope in betterAuth.ts).
//   - the database and its table mapping: the same drizzle adapter options and the app's own schema.
// If any of them drifts, the `auth-setup` project (scenarios/auth.setup.ts) fails before a spec runs.

import { betterAuth } from 'better-auth';
import { testUtils, type TestHelpers } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sslFor } from './scenarios/helpers/db';
import * as schema from '../src/lib/chat/server/db/schema';

const PREVIEW_COOKIE_PREFIX = 'aip-preview';

function required(name: string, why: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set: ${why}`);
	return value;
}

function buildTestAuth() {
	const baseURL = required(
		'SCENARIO_BASE_URL',
		'the minted cookie is scoped to the deployment under test.'
	).replace(/\/+$/, '');
	const secret = required(
		'BETTER_AUTH_SECRET',
		"the minted session cookie is signed with it, so it has to be the preview's own value (Doppler `preview`, read by scenario-suite-check.yml)."
	);
	const databaseUrl = required(
		'SCENARIO_DATABASE_URL',
		'the minted user and session are written to the database the deployment reads.'
	);
	const sql = postgres(databaseUrl, { ssl: sslFor(databaseUrl), max: 2 });
	return betterAuth({
		database: drizzleAdapter(drizzle(sql, { schema }), {
			provider: 'pg',
			schema,
			usePlural: false
		}),
		secret,
		baseURL,
		basePath: '/chat/api/auth',
		advanced: { cookiePrefix: PREVIEW_COOKIE_PREFIX },
		plugins: [testUtils()]
	});
}

let helpers: Promise<TestHelpers> | undefined;

/** The test-utils helpers, built on first use so importing this file (knip, config loading) never
 *  needs the environment or a database connection. */
export function testAuthHelpers(): Promise<TestHelpers> {
	helpers ??= buildTestAuth().$context.then(
		(ctx) => (ctx as unknown as { test: TestHelpers }).test
	);
	return helpers;
}
