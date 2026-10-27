#!/usr/bin/env node
// cleanup-e2e-artifacts — delete the rows web/e2e/scenarios' sign-in and workspace specs leave
// behind in a real, PERSISTENT database.
//
// WHY THIS EXISTS: CUR-1150 moved the scenario suite off an ephemeral per-PR Neon branch (deleted
// when the PR closed) onto the shared `preview` Doppler config's own database, so every scenario
// run now — sign-in, workspace creation — writes real rows that nothing else ever deletes.
// web/src/lib/chat/server/db/cleanup.ts only ever covered `conversations`; verification/user/
// session/account/organization/member were never in scope because CUR-1077's original design
// didn't need them to be. Run after every scenario-suite-check.yml run (`if: always()`, so a
// failed run still cleans up whatever it managed to create) so this doesn't quietly become "the
// preview verification/organization tables are full of thousands of e2e-* rows."
//
// Scoped by construction, not by trusting a WHERE clause alone: every row this suite creates is
// tagged at creation time — freshTestEmail() always mints `e2e-<uuid>@example.org` or `@currentai.org` (`e2e-r<run>-<uuid>` in CI)
// (web/e2e/scenarios/helpers/signIn.ts), workspaces.spec.ts always names its workspace
// `E2E Workspace <timestamp>`. Nothing outside this suite has ever had a reason to create either
// shape, so these patterns can't collide with real user data. `isE2eEmail` below re-checks every
// account the SQL selected, and a single mismatch aborts the run before anything is deleted (CUR-2529).
//
// Two identities per e2e sign-in. Better Auth's own `user` row, and the legacy shadow `users` row the
// auth bridge mints on first sign-in (auth.ts, keyed by shadowUserId) with the account's `settings`
// and any conversations migrated onto it (CUR-2529). Both are deleted. The shadow rows carry the same
// email in `doc`, so the same pattern finds them, including any an earlier run left behind.
//
// Everything runs in one transaction. organization->member and user->session/account/member
// cascade on delete (schema.ts), so `member`, `session` and `account` need no DELETE of their own.
// `verification` is independent (identifier-keyed, no FK to user). `passkey` has no onDelete:cascade
// on userId (@better-auth/passkey declares its own schema; wipeUserData.ts handles the same gotcha),
// so it goes before `user`. On the legacy side, `reports` references `conversations` and is detached
// rather than deleted, as deleteConversations.ts does; conversations, settings and sessions reference
// `users` (CUR-769), so they go before it.
//
// Usage: DATABASE_URL=postgres://... node scripts/cleanup-e2e-artifacts.mjs [--run <GITHUB_RUN_ID>] [--min-age-minutes N]
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MOCK_OIDC_EMAIL = "mock-oidc-e2e@example.org";

/** The domains freshTestEmail mints on: example.org, and currentai.org for a spec that signs in on a
 *  staff domain a flag targets (CUR-2725). A real staff address never starts `e2e-`. */
const E2E_DOMAINS = ["example.org", "currentai.org"];

/** The email shapes this suite mints. Independent of the SQL `like` on purpose. */
export function isE2eEmail(email) {
	return email === MOCK_OIDC_EMAIL || /^e2e-[^@\s]+@(example|currentai)\.org$/.test(email ?? "");
}

function assertAllE2e(table, rows) {
	const strays = rows.filter((r) => !isE2eEmail(r.email));
	if (strays.length > 0) {
		throw new Error(
			`cleanup-e2e-artifacts: refusing to delete — ${strays.length} ${table} row(s) selected for deletion do not carry an e2e email (first: ${JSON.stringify(strays[0].email)}). Nothing was deleted.`
		);
	}
}

/** The minutes an account from another run is kept: past the longest job that signs one in
 *  (100 minutes), so a run still using its accounts is never signed out by another. */
const MIN_AGE_MINUTES = 180;

/** freshTestEmail's run tag (helpers/signIn.ts), as the SQL `like`s for one run's own accounts. */
export function runPatterns(runId) {
	if (!/^\d+$/.test(String(runId)))
		throw new Error(`cleanup-e2e-artifacts: run id must be digits, got ${JSON.stringify(runId)}`);
	return E2E_DOMAINS.map((domain) => `e2e-r${runId}-%@${domain}`);
}

/**
 * Delete e2e artifacts in one transaction: every account this run minted (`runId`, matched by the
 * tag freshTestEmail puts in the address), and any other e2e account older than `minAgeMinutes`.
 * Several workflows sign in against the same database (develop's serves the scenario, persona
 * and live suites), so deleting every e2e account would sign out whichever run is still going.
 * An old account is past any run that could use it, which is also how a cancelled run's are cleared.
 * `patterns` are the SQL `like`s for e2e emails, a parameter only so a test can injure them and watch
 * the guard refuse.
 */
export async function cleanupE2eArtifacts(
	sql,
	{
		patterns = E2E_DOMAINS.map((domain) => `e2e-%@${domain}`),
		runId = null,
		runIds = runId == null ? [] : [runId],
		minAgeMinutes = MIN_AGE_MINUTES,
	} = {}
) {
	const own = runIds.flatMap(runPatterns);
	const ownOtp = runIds.map((id) => `sign-in-otp-e2e-r${id}-%`);
	const before = new Date(Date.now() - minAgeMinutes * 60_000);
	return sql.begin(async (tx) => {
		const baUsers = await tx`select id, email from "user"
			where (email like any(${patterns}::text[]) or email = ${MOCK_OIDC_EMAIL})
			and (created_at < ${before} or email like any(${own}::text[]))`;
		// A shadow row goes with its Better Auth user, or alone once that user is gone (an earlier
		// run's leftover). users.created_at is nullable, so its age is never read.
		const baEmails = baUsers.map((r) => r.email);
		const shadowUsers = await tx`select id, doc->>'email' as email from users
			where (doc->>'email' like any(${patterns}::text[]) or doc->>'email' = ${MOCK_OIDC_EMAIL})
			and (doc->>'email' = any(${baEmails})
				or not exists (select 1 from "user" u where u.email = users.doc->>'email'))`;
		assertAllE2e('"user"', baUsers);
		assertAllE2e("users", shadowUsers);
		const baIds = baUsers.map((r) => r.id);
		const shadowIds = shadowUsers.map((r) => r.id);

		const passkeys = await tx`delete from passkey where user_id = any(${baIds}) returning id`;
		const orgs =
			await tx`delete from organization where name like 'E2E Workspace %' and created_at < ${before} returning id`;
		const users = await tx`delete from "user" where id = any(${baIds}) returning id`;
		const verifications = await tx`delete from verification where identifier like 'sign-in-otp-e2e-%'
			and (created_at < ${before} or identifier like any(${ownOtp}::text[])) returning id`;

		// Detach, never delete: a report outlives its conversation (deleteConversations.ts does the same).
		const reports =
			await tx`update reports set conversation_id = null where conversation_id in (select id from conversations where user_id = any(${shadowIds})) returning id`;
		const conversations = await tx`delete from conversations where user_id = any(${shadowIds}) returning id`;
		const settings = await tx`delete from settings where user_id = any(${shadowIds}) returning id`;
		const sessions = await tx`delete from sessions where user_id = any(${shadowIds}) returning id`;
		const shadows = await tx`delete from users where id = any(${shadowIds}) returning id`;

		return {
			organizations: orgs.length,
			users: users.length,
			passkeys: passkeys.length,
			verifications: verifications.length,
			shadowUsers: shadows.length,
			settings: settings.length,
			conversations: conversations.length,
			reports: reports.length,
			sessions: sessions.length,
		};
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const DATABASE_URL = process.env.DATABASE_URL;
	if (!DATABASE_URL) {
		console.error("Usage: DATABASE_URL=postgres://... node scripts/cleanup-e2e-artifacts.mjs");
		process.exit(1);
	}
	// --run repeats: the pre-run sweep passes every cancelled predecessor of this PR's run (CUR-2918).
	const { values } = parseArgs({
		options: { run: { type: "string", multiple: true }, "min-age-minutes": { type: "string" } },
	});
	const runIds = (values.run ?? []).filter(Boolean);
	const minAgeMinutes = Number(values["min-age-minutes"] ?? MIN_AGE_MINUTES);
	const sql = postgres(DATABASE_URL, { ssl: "require" });
	try {
		const n = await cleanupE2eArtifacts(sql, { runIds, minAgeMinutes });
		console.log(
			`cleanup-e2e-artifacts: run ${runIds.join(", ") || "(none)"}'s own accounts, and any other older than ${minAgeMinutes} min`
		);
		console.log(
			`cleanup-e2e-artifacts: ${n.organizations} organization(s), ${n.users} user(s) (session/account/member cascaded), ${n.passkeys} passkey(s), ${n.verifications} verification row(s); legacy: ${n.shadowUsers} shadow user(s), ${n.settings} settings, ${n.conversations} conversation(s), ${n.reports} report(s) detached, ${n.sessions} session(s)`
		);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}
