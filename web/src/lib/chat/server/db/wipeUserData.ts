/**
 * GDPR erasure (Art. 17) for a guest/user — the "clear everything we hold about you" wipe behind the
 * trash-all. Deletes the user's conversation content + settings + session + their rate-limit and
 * contribution rows, plus any local (LAN/self-hosted) inference endpoint they've configured
 * (CUR-1194), the person's uploaded files in custodial storage, and their non-child-safety
 * `safety_events` decline records. Two deliberate carve-outs: child-safety `safety_events`, and safety
 * `reports`, which are RETAINED for legal/safety compliance (Art. 17(3)); deleteConversationsCascade detaches
 * them from the deleted conversation rather than deleting them, and the wipe clears who filed them
 * (CUR-2726). We also can't touch our safety provider's (Coop's) own records — those live in Coop's
 * system and are retained per its compliance.
 *
 * Every table is keyed by the caller's own identifiers — sessionId and/or userId. message_events and
 * contributions are NOT keyed by ipHash here even though both carry one: an IP is shared (campus NAT,
 * carrier CGNAT, a VPN exit), so wiping by it would delete strangers' "Get involved" signups and reset their
 * rate-limit counters. Both writers stamp `userId = user._id ?? sessionId` (rateLimit.ts,
 * api/contribute), so the caller's own rows are reachable without the IP.
 *
 * An account wipe also deletes the shadow `users` row (CUR-434, see wipeCoverage.spec.ts) and, when
 * it's Better-Auth-backed, the linked Better Auth `account`/`passkey`/`session`/`user` rows — those are
 * keyed by BETTER AUTH'S OWN user.id (stored on the shadow row as `betterAuthUserId`, since it can't be
 * recovered from `_id`, a one-way hash of it — see the comment on that field in types/User.ts). And
 * `token_caches`, if the account ever used the bearer-token API path: keyed by the raw Hugging Face user
 * id (the SAME value as `users.hfUserId`), not by `_id`, matching auth.ts's
 * `tokenCaches.insertOne({ userId: data.id, ... })`.
 *
 * The account goes only when the caller asks for it (`deleteAccount`, CUR-1420). "Forget everything" clears
 * a signed-in person's data and leaves them signed in to the same account, the way a browser's "clear
 * history" never signs you out of the browser's own account; "Delete account" is the separate action
 * that also removes the account and its sign-in methods. A guest has no account, so for a guest the
 * two are the same wipe.
 */
import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { getDb, withTransaction } from "./client";
import * as schema from "./schema";
import { deleteConversationsCascade } from "./deleteConversations";
import { deleteAgentServiceData } from "$lib/chat/server/deleteAgentServiceData";
import { wipeCustodialFiles } from "$lib/chat/server/storage/custodialStorage";
import { logger } from "$lib/chat/server/logger";
import type { WipeSummary } from "$lib/chat/types/WipeSummary";

export type { WipeSummary };

export interface WipeKeys {
	sessionId?: string;
	userId?: string;
	/** Also delete the account and its sign-in methods. Off by default: data and account are separate
	 *  actions (CUR-1420), so a caller that forgets to say which gets the one that can be recovered from. */
	deleteAccount?: boolean;
}

/** OR the present conditions; undefined when none apply (so we never build an empty/match-all WHERE). */
function any(conds: (SQL | undefined)[]): SQL | undefined {
	const present = conds.filter((c): c is SQL => c !== undefined);
	if (present.length === 0) return undefined;
	return present.length === 1 ? present[0] : or(...present);
}

export async function wipeUserData(keys: WipeKeys): Promise<WipeSummary> {
	const db = getDb();
	const summary: WipeSummary = {
		conversations: 0,
		settings: 0,
		messageEvents: 0,
		contributions: 0,
		localInferenceEndpoints: 0,
		storageLocations: 0,
		safetyEvents: 0,
		reportsRetained: 0,
		accountDeleted: false,
	};
	const sid = keys.sessionId;
	const uid = keys.userId;
	// The identifiers message_events/contributions stamp as `userId` for this caller.
	const ownIds = [uid, sid].filter((v): v is string => !!v);
	// Per-step timing for one log line (CUR-4548): which part of a slow wipe the person waited on.
	const started = Date.now();
	const timing: Record<string, number> = {};

	// 0. Uploaded files in custodial storage (the HF bucket, users/<uid>/). FIRST, before any row is
	//    deleted: a failure here throws and the wipe stops with the account intact, so the person
	//    can retry. Run last, a failure would leave files behind an account that no longer exists,
	//    which nobody can reach again (signing back in would show "No files yet" while the bucket still
	//    held the upload). `undefined` means storage is not configured
	//    on this deployment, which is not the same claim as "held nothing".
	if (uid) {
		summary.custodialFiles = await wipeCustodialFiles(uid, { keepAccount: keys.deleteAccount !== true, timing });
	}
	const custodialDone = Date.now();

	// 1. Conversations (by session/user) → cascade. The cascade RETAINS reports (detaches them); note
	//    which ones first, so step 1b can strip who filed them and the summary can disclose the count.
	const convWhere = any([
		sid ? eq(schema.conversations.sessionId, sid) : undefined,
		uid ? eq(schema.conversations.userId, uid) : undefined,
	]);
	const retainedReportIds = new Set<string>();
	if (convWhere) {
		const convIds = (
			await db.select({ id: schema.conversations.id }).from(schema.conversations).where(convWhere)
		).map((r) => r.id);
		if (convIds.length) {
			const attached = await db
				.select({ id: schema.reports.id })
				.from(schema.reports)
				.where(inArray(schema.reports.conversationId, convIds));
			for (const r of attached) retainedReportIds.add(r.id);
			// A signed-in wipe deleted the whole users/<id>/ prefix above; a guest's goes per conversation
			// under guests/<sessionId>/ (CUR-2183).
			summary.conversations = await deleteConversationsCascade(convIds, undefined, uid ? undefined : sid);
		}
	}

	// 1b. Retained reports keep what the retention basis needs (reason, detail, the reported answer)
	//     and lose who filed them. The done screen tells the person a kept report "no longer points to
	//     you"; detaching the conversation alone would leave user_id and session_id on the row (CUR-2726). A
	//     general report the caller filed has no conversation, so it is found by identity instead.
	const reporterWhere = any([
		uid ? eq(schema.reports.userId, uid) : undefined,
		sid ? eq(schema.reports.sessionId, sid) : undefined,
	]);
	if (reporterWhere) {
		const filed = await db.select({ id: schema.reports.id }).from(schema.reports).where(reporterWhere);
		for (const r of filed) retainedReportIds.add(r.id);
	}
	if (retainedReportIds.size) {
		await db
			.update(schema.reports)
			.set({ userId: null, sessionId: null })
			.where(inArray(schema.reports.id, [...retainedReportIds]));
	}
	summary.reportsRetained = retainedReportIds.size;

	// 2. Settings (by session/user).
	const settingsWhere = any([
		sid ? eq(schema.settings.sessionId, sid) : undefined,
		uid ? eq(schema.settings.userId, uid) : undefined,
	]);
	if (settingsWhere) {
		summary.settings = (
			await db.delete(schema.settings).where(settingsWhere).returning({ id: schema.settings.id })
		).length;
	}

	// 2b. Local inference endpoint(s) — CUR-1194, signed-in-user-only (no session/guest analog, unlike
	//     settings above). onDelete:cascade on the FK would clean this up on its own once the shadow
	//     `users` row is deleted in step 6, but it's deleted explicitly here anyway — same reasoning as
	//     account/passkey/session below (a summary count and an explicit, auditable step beat a silent
	//     cascade), and it's what makes this table visible to wipeCoverage.spec.ts's completeness gate.
	if (uid) {
		summary.localInferenceEndpoints = (
			await db
				.delete(schema.localInferenceEndpoints)
				.where(eq(schema.localInferenceEndpoints.userId, uid))
				.returning({ id: schema.localInferenceEndpoints.id })
		).length;
	}

	// 2b'. CLI pairing handoffs (CUR-4110), which may still hold an uncollected tunnel secret. Before the
	//     endpoints would cascade them anyway; deleted by user here so a claim still provisioning, with no
	//     endpoint yet, goes too.
	if (uid) {
		await db.delete(schema.localInferencePairings).where(eq(schema.localInferencePairings.userId, uid));
	}

	// 2c. Human evaluation (A2, CUR-1914): the person's ratings and language profiles. Signed-in only,
	//     since evaluation requires an account. Ratings are deleted rather than detached: published
	//     results are aggregates recomputed from what remains.
	if (uid) {
		summary.humanEvalRatings = (
			await db
				.delete(schema.humanEvalRatings)
				.where(eq(schema.humanEvalRatings.userId, uid))
				.returning({ id: schema.humanEvalRatings.id })
		).length;
		summary.humanEvalProfiles = (
			await db
				.delete(schema.humanEvalProfiles)
				.where(eq(schema.humanEvalProfiles.userId, uid))
				.returning({ id: schema.humanEvalProfiles.id })
		).length;
	}

	// 2c. Linked storage locations and the default-location choice (CUR-2930). Same explicit-delete
	//     reasoning as 2b. This removes our sealed copy of each credential; the files in the person's
	//     own bucket are theirs and are not touched.
	if (uid) {
		summary.storageLocations = (
			await db
				.delete(schema.storageLocations)
				.where(eq(schema.storageLocations.userId, uid))
				.returning({ id: schema.storageLocations.id })
		).length;
		await db.delete(schema.storagePreferences).where(eq(schema.storagePreferences.userId, uid));
	}

	// 2d. MCP servers the person added in Settings → Connectors (CUR-4016), with our sealed copy of each
	//     token. The FK cascades too; deleting here keeps the wipe from depending on the account row going.
	if (uid) {
		await db.delete(schema.userMcpServers).where(eq(schema.userMcpServers.userId, uid));
	}

	// 2e. Sync tombstones (CUR-4312): which conversations and messages this account deleted, kept so a
	//     connected Thunderbolt can mirror the delete. They name deleted ids and nothing else; the wipe
	//     takes them too, and the connection itself goes only with the account (step 6).
	if (uid) {
		await db.delete(schema.syncTombstones).where(eq(schema.syncTombstones.userId, uid));
	}

	// 3. message_events — by the caller's own userId/sessionId, never by ipHash (see header).
	if (ownIds.length > 0) {
		summary.messageEvents = (
			await db
				.delete(schema.messageEvents)
				.where(inArray(schema.messageEvents.userId, ownIds))
				.returning({ id: schema.messageEvents.id })
		).length;
	}

	// 4. contributions — same keys, same reason.
	if (ownIds.length > 0) {
		summary.contributions = (
			await db
				.delete(schema.contributions)
				.where(inArray(schema.contributions.userId, ownIds))
				.returning({ id: schema.contributions.id })
		).length;
	}

	// 4b. safety_events — every decline record for this caller EXCEPT child-safety ones. Only
	//     `kind = 'child_safety'` carries the Art. 17(3) retention basis (and feeds the fail-closed
	//     decline probe, safetyEvents.ts); a privacy or content-policy decline is ordinary data about
	//     the person and goes with the account. Keyed the way the writer stamps it
	//     (conversation/[id]/+server.ts: userId = user._id ?? sessionId, plus sessionId).
	const safetyWhere = any([
		ownIds.length > 0 ? inArray(schema.safetyEvents.userId, ownIds) : undefined,
		sid ? eq(schema.safetyEvents.sessionId, sid) : undefined,
	]);
	if (safetyWhere) {
		summary.safetyEvents = (
			await db
				.delete(schema.safetyEvents)
				.where(and(safetyWhere, ne(schema.safetyEvents.kind, "child_safety")))
				.returning({ id: schema.safetyEvents.id })
		).length;
	}

	// 5. The session row itself (guest identity). A fresh anonymous session is minted on the next
	//    request, so the user keeps using the app — just with nothing tied to them anymore. A signed-in
	//    person keeping their account keeps this row too: it carries their userId, and deleting it is a
	//    sign-out they did not ask for.
	const deleteAccount = keys.deleteAccount === true;
	if (sid && (!uid || deleteAccount)) {
		await db.delete(schema.sessions).where(eq(schema.sessions.sessionId, sid));
	}

	// 6. The account itself (CUR-434). Read hfUserId/betterAuthUserId off the shadow row BEFORE deleting
	//    it — both are needed to find rows keyed by a DIFFERENT identifier space than `uid`.
	//    One transaction (CUR-2925): the Better Auth rows go before the shadow row, so a shadow delete
	//    that failed outside a transaction would leave the person unable to sign in while their account row
	//    and its data stayed behind. Every legacy `sessions` row naming the account goes first, since
	//    its foreign key (0023_user_id_foreign_keys.sql) refuses the shadow delete otherwise.
	if (uid && deleteAccount) {
		summary.accountDeleted = await withTransaction(() => deleteAccountRows(uid));
	}

	// 7. agent-service's own store (CUR-1722) — a separate SQLite database this function never
	//    reached before, keyed by the same HMAC subject agentSubjectFor derives for a live turn. Same
	//    precedence: signed-in uid over guest sid, matching what a turn from this visitor would have
	//    been recorded under.
	const dbDone = Date.now();
	summary.agentServiceTasksDeleted = await deleteAgentServiceData(uid ?? sid);

	const now = Date.now();
	logger.info(
		{
			event: "wipe-timing",
			signedIn: !!uid,
			deleteAccount,
			ms: now - started,
			custodialMs: custodialDone - started,
			dbMs: dbDone - custodialDone,
			agentServiceMs: now - dbDone,
			...timing,
		},
		"[wipe] user data wiped"
	);
	return summary;
}

/** Step 6's deletes, run inside the caller's transaction. True when the shadow row existed. */
async function deleteAccountRows(uid: string): Promise<boolean> {
	const db = getDb();
	const [userRow] = await db
		.select({ hfUserId: schema.users.hfUserId, doc: schema.users.doc })
		.from(schema.users)
		.where(eq(schema.users.id, uid));
	if (!userRow) return false;

	const betterAuthUserId = (userRow.doc as { betterAuthUserId?: string }).betterAuthUserId;
	if (betterAuthUserId) {
		// Order matters: account/passkey/session reference user.id with onDelete cascade for
		// account/session (schema.ts) but NOT passkey (that plugin declares no cascade), so
		// passkey must be deleted explicitly regardless — deleting all three before the parent
		// row is simplest and correct either way.
		await db.delete(schema.account).where(eq(schema.account.userId, betterAuthUserId));
		await db.delete(schema.passkey).where(eq(schema.passkey.userId, betterAuthUserId));
		// What the person granted a sync client (Thunderbolt), and any client they own. The
		// tokens go before the session they may name, and every row here also cascades from `user`. (CUR-4312)
		await db.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.userId, betterAuthUserId));
		await db.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, betterAuthUserId));
		await db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.userId, betterAuthUserId));
		await db.delete(schema.oauthClient).where(eq(schema.oauthClient.userId, betterAuthUserId));
		await db.delete(schema.session).where(eq(schema.session.userId, betterAuthUserId));
		await db.delete(schema.user).where(eq(schema.user.id, betterAuthUserId));
	}

	if (userRow.hfUserId) {
		await db.delete(schema.tokenCaches).where(eq(schema.tokenCaches.userId, userRow.hfUserId));
	}

	await db.delete(schema.sessions).where(eq(schema.sessions.userId, uid));
	await db.delete(schema.users).where(eq(schema.users.id, uid));
	return true;
}
