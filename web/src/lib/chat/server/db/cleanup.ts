/**
 * TTL garbage collection for the infra tables.
 *
 * MongoDB expired these rows with native TTL indexes (`expireAfterSeconds`). Postgres has no native
 * TTL, so expiry is enforced two ways: the app already IGNORES expired rows at query time (e.g.
 * tokenCaches filters `createdAt > now-5min`, sessions check `expiresAt`), and this job DELETES them so
 * they don't accumulate. Correctness never depends on the GC having run — it only bounds table growth.
 *
 * Run via the daily Vercel cron (`/api/cleanup`, see vercel.json) or locally with
 * `DATABASE_URL=… npx tsx scripts/verify-cleanup.ts` (seeds + asserts) or by hitting `GET /api/cleanup`.
 *
 * Every predicate hits a promoted, indexed column (see schema.ts): sessions.expiresAt,
 * messageEvents.expiresAt, semaphores.deleteAt, tokenCaches.createdAt, abortedGenerations.updatedAt,
 * mcpElicitations.updatedAt, conversations.updatedAt. The last one is different in kind: it enforces
 * the user-facing /privacy retention promise (delete guest conversations after RETENTION_DAYS), not
 * just infra-table hygiene.
 *
 * `upload_chunks` (CUR-1780) is swept an hour after its newest write: an upload that has not finished
 * by then never will, and its bytes were never scanned.
 *
 * `local_inference_pairings` (CUR-4110) is swept on `expiresAt` too: an expired pairing's CLI stopped
 * polling long ago, and a row nobody collected still holds a tunnel secret. collectPairing() already
 * refuses an expired row, so the sweep only bounds how long that secret sits in the table.
 *
 * Better Auth's own `session` and `verification` tables are swept on `expires_at` too (CUR-939). Better
 * Auth drops an expired row only when it next reads it, so a session from a device that never returns,
 * or a sign-in code nobody entered, otherwise stays for good — and a `verification` row carries the
 * email address it was sent to. Neither table indexes `expires_at`; both hold tens of rows in
 * production, so a daily sequential scan costs nothing and no migration is needed until that changes.
 *
 * `safety_events` (CUR-4428) is swept on `createdAt` after SAFETY_RECORD_RETENTION_DAYS, the period the
 * privacy notice states for safety records. child_safety rows are never swept here: their period is a
 * legal decision still open under CUR-2577.
 *
 * `account` is deliberately NOT swept. Its only expiry columns are the provider's access and refresh
 * token expiries, not the account's: an expired access token is the normal state of a linked account,
 * and deleting on that column would unlink every Google, GitHub and Hugging Face sign-in.
 */
import { and, isNull, lt, inArray, ne } from "drizzle-orm";
import { getDb } from "./client";
import { sweepAbandonedUploadChunks } from "./uploadChunks";
import { sweepSyncTombstones } from "./syncTombstones";
import * as schema from "./schema";
// Relative (not `$lib`) so this module also resolves under tsx in scripts/verify-cleanup.ts,
// which runs outside Vite and can't resolve SvelteKit's `$lib` alias.
import { RETENTION_MS, SAFETY_RECORD_RETENTION_DAYS } from "../../constants/retention";

// tokenCaches: the auth path honours a 5-minute cache by query (auth.ts) — match it here.
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
// abortedGenerations: cross-instance stop markers. They matter only while a generation is in flight;
// no generation runs anywhere near an hour, so an hour-old marker is certainly dead. Generous on
// purpose — this is a safe-GC floor, not a correctness-critical TTL.
const ABORTED_GENERATION_TTL_MS = 60 * 60 * 1000;
// mcpElicitations: a parked question nobody ever answers. Generous for the same reason as above —
// this is a safe-GC floor, not a claim about how long a real user takes to fill in a form.
const MCP_ELICITATION_TTL_MS = 24 * 60 * 60 * 1000;
const SAFETY_RECORD_TTL_MS = SAFETY_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type CleanupCounts = {
	sessions: number;
	messageEvents: number;
	semaphores: number;
	tokenCaches: number;
	abortedGenerations: number;
	mcpElicitations: number;
	// Better Auth's own tables (CUR-939).
	authSessions: number;
	verifications: number;
	// Conversations past the retention window (the /privacy "deleted after N days" promise).
	conversations: number;
	// CLI pairing handoffs past their expiry (CUR-4110).
	localInferencePairings: number;
	// Chunks of My files uploads abandoned before they finished (CUR-1780).
	uploadChunks: number;
	// Sync tombstones past their 30 days, and sync access tokens past their expiry (CUR-4312).
	syncTombstones: number;
	oauthAccessTokens: number;
	// Safety decline records past SAFETY_RECORD_RETENTION_DAYS, child_safety excepted (CUR-4428).
	safetyEvents: number;
};

/**
 * Delete rows that have passed their expiry. Idempotent and safe to run any time; rows with a NULL
 * expiry column are never touched (NULL < now is NULL, i.e. not matched). Returns per-table delete
 * counts. `now` is injectable so the verification harness can reason about fixed boundaries.
 */
export async function cleanupExpired(now: Date = new Date()): Promise<CleanupCounts> {
	const db = getDb();
	const tokenCacheCutoff = new Date(now.getTime() - TOKEN_CACHE_TTL_MS);
	const abortedCutoff = new Date(now.getTime() - ABORTED_GENERATION_TTL_MS);
	const elicitationCutoff = new Date(now.getTime() - MCP_ELICITATION_TTL_MS);
	const safetyEventsCutoff = new Date(now.getTime() - SAFETY_RECORD_TTL_MS);

	// Absolute-expiry tables compare against `now`; relative-TTL tables against their cutoff.
	// `.returning({ id })` lets us report a delete count without a separate query.
	const [
		sessions,
		messageEvents,
		semaphores,
		tokenCaches,
		abortedGenerations,
		mcpElicitations,
		authSessions,
		verifications,
		localInferencePairings,
		uploadChunks,
		syncTombstones,
		oauthAccessTokens,
		safetyEvents,
	] = await Promise.all([
		db
			.delete(schema.sessions)
			.where(lt(schema.sessions.expiresAt, now))
			.returning({ id: schema.sessions.id }),
		db
			.delete(schema.messageEvents)
			.where(lt(schema.messageEvents.expiresAt, now))
			.returning({ id: schema.messageEvents.id }),
		db
			.delete(schema.semaphores)
			.where(lt(schema.semaphores.deleteAt, now))
			.returning({ id: schema.semaphores.id }),
		db
			.delete(schema.tokenCaches)
			.where(lt(schema.tokenCaches.createdAt, tokenCacheCutoff))
			.returning({ id: schema.tokenCaches.id }),
		db
			.delete(schema.abortedGenerations)
			.where(lt(schema.abortedGenerations.updatedAt, abortedCutoff))
			.returning({ id: schema.abortedGenerations.id }),
		db
			.delete(schema.mcpElicitations)
			.where(lt(schema.mcpElicitations.updatedAt, elicitationCutoff))
			.returning({ id: schema.mcpElicitations.id }),
		db
			.delete(schema.session)
			.where(lt(schema.session.expiresAt, now))
			.returning({ id: schema.session.id }),
		db
			.delete(schema.verification)
			.where(lt(schema.verification.expiresAt, now))
			.returning({ id: schema.verification.id }),
		db
			.delete(schema.localInferencePairings)
			.where(lt(schema.localInferencePairings.expiresAt, now))
			.returning({ id: schema.localInferencePairings.pairingIdHash }),
		sweepAbandonedUploadChunks(now),
		sweepSyncTombstones(now),
		// An access token lives an hour and is never read again once lapsed; its refresh token (30 days)
		// is what Better Auth's own rotation and revocation act on, so those stay until the plugin's.
		db
			.delete(schema.oauthAccessToken)
			.where(lt(schema.oauthAccessToken.expiresAt, now))
			.returning({ id: schema.oauthAccessToken.id }),
		db
			.delete(schema.safetyEvents)
			.where(
				and(ne(schema.safetyEvents.kind, "child_safety"), lt(schema.safetyEvents.createdAt, safetyEventsCutoff))
			)
			.returning({ id: schema.safetyEvents.id }),
	]);

	// Conversation retention — the user-facing /privacy promise ("guest conversations are
	// automatically deleted after N days"), not just infra-table hygiene. Messages live embedded
	// in conversations.doc, so deleting the row erases them. Dependents must go FIRST: reports has a
	// NOT NULL FK to conversations.id (a bare conversation delete would FK-fail), and files carry a
	// conversationId. Snapshot the expired ids, delete by id in one transaction so the dependent
	// deletes and the conversation delete operate on exactly the same set.
	//
	// GUEST conversations only (userId IS NULL) (CUR-830). A signed-in user's conversations live until
	// they delete them (wipeUserData / the trash-all) or the account goes, as the notice's account-data row,
	// the settings page's conversation list, and the whole "sign in when I want it to remember me" premise
	// (A1) say; dormant-account expiry is a separate decision with a warning email in front of it, not
	// this sweep.
	const conversationsCutoff = new Date(now.getTime() - RETENTION_MS);
	const conversations = await db.transaction(async (tx) => {
		const expired = await tx
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(
				and(isNull(schema.conversations.userId), lt(schema.conversations.updatedAt, conversationsCutoff))
			);
		const expiredIds = expired.map((r) => r.id);
		if (expiredIds.length === 0) return [] as { id: string }[];
		await tx.delete(schema.reports).where(inArray(schema.reports.conversationId, expiredIds));
		await tx.delete(schema.files).where(inArray(schema.files.conversationId, expiredIds));
		return tx
			.delete(schema.conversations)
			.where(inArray(schema.conversations.id, expiredIds))
			.returning({ id: schema.conversations.id });
	});

	return {
		sessions: sessions.length,
		messageEvents: messageEvents.length,
		semaphores: semaphores.length,
		tokenCaches: tokenCaches.length,
		abortedGenerations: abortedGenerations.length,
		mcpElicitations: mcpElicitations.length,
		authSessions: authSessions.length,
		verifications: verifications.length,
		conversations: conversations.length,
		localInferencePairings: localInferencePairings.length,
		uploadChunks,
		syncTombstones,
		oauthAccessTokens: oauthAccessTokens.length,
		safetyEvents: safetyEvents.length,
	};
}
