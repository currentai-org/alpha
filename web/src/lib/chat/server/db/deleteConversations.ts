/**
 * FK-ordered cascade delete for conversations — the single place conversation deletion happens so
 * the foreign keys can't block it. `files` carry a `conversationId`, and `reports.conversationId` is
 * an FK to `conversations.id` with no ON DELETE, so a bare conversation delete throws a foreign-key
 * violation the moment a conversation has a file or report. Resolve the dependents FIRST, in one
 * transaction. Mirrors the TTL sweep in db/cleanup.ts.
 *
 * COMPLIANCE CARVE-OUT: safety `reports` must be RETAINED even when a conversation is
 * deleted (legal/safety retention, Art. 17(3)). So we DETACH them (null the now-nullable
 * conversationId) rather than delete them — the safety record survives, decoupled from the deleted
 * chat. Applies to BOTH per-chat delete and Delete-all / the GDPR wipe.
 */
import { inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";
import { AbortRegistry } from "../abortRegistry";
import { deleteCustodialFolders } from "../storage/custodialStorage";

/**
 * @param ownerId the signed-in owner of every conversation named, whose My files copies of their
 * attachments (`conversations/<id>/`, CUR-2172) go with them (CUR-2183). Deleted BEFORE the rows: a
 * bucket failure throws and leaves the conversations in place to delete again, rather than reporting
 * them gone while their files remain. Omitted by the account wipe, which deletes the person's whole
 * prefix itself.
 * @param guestSessionId for a guest's conversations, the session whose `guests/<id>/` copies go with
 * them, the same way. Ignored when `ownerId` is given.
 *
 * Whatever the caller passes, a conversation that began as a guest's also loses the copies the
 * sign-in move left under `guests/<formerGuestSessionId>/` (a failed or over-quota move, CUR-3292).
 * Read here from the rows, so the routes and the account wipe can't each forget it.
 */
export async function deleteConversationsCascade(
	conversationIds: string[],
	ownerId?: string,
	guestSessionId?: string
): Promise<number> {
	if (conversationIds.length === 0) return 0;

	if (ownerId) await deleteCustodialFolders(ownerId, "conversations", conversationIds);
	else if (guestSessionId) await deleteCustodialFolders(guestSessionId, "conversations", conversationIds, "guests");
	for (const [formerGuest, ids] of await formerGuestSessions(conversationIds)) {
		await deleteCustodialFolders(formerGuest, "conversations", ids, "guests");
	}

	// A conversation being deleted here can have a generation actively
	// streaming against it (a mid-stream "Forget everything", or an ordinary single-conversation
	// delete during a turn). Left alone, that generation runs to its own ~45s watchdog and ends in a
	// user-visible error + Retry — against a conversation that's already gone. Aborting here routes
	// it through the SAME code path a manual "Stop generating" click already uses
	// (conversation/[id]/+server.ts's `ctrl.signal.aborted && !timedOut` branch), which persists a
	// graceful interrupted final answer instead of an error. Fire before the delete transaction so
	// the generation's own cleanup has the best chance of racing against a still-live row; if it
	// loses that race its write is a no-op (Mongo-shaped `updateOne` on a missing document), not a
	// failure. (CUR-1619/CUR-1620/CUR-1773)
	for (const id of conversationIds) {
		AbortRegistry.getInstance().abort(id);
	}
	// The conversations' code sandboxes and agent workdirs go with them. Started here and
	// awaited after the rows, so a slow agent-service adds no time to the delete transaction. Imported
	// on demand: the helper pulls in the agent endpoint, which nothing else here needs. (CUR-4484)
	const visitor = ownerId ?? guestSessionId;
	const agentCleanup = visitor
		? import("../deleteAgentServiceData").then((m) => m.deleteAgentSessions(visitor, conversationIds)).catch(() => undefined)
		: undefined;

	const db = getDb();
	const deletedCount = await db.transaction(async (tx) => {
		// RETAIN reports for compliance — detach from the conversation instead of deleting.
		await tx
			.update(schema.reports)
			.set({ conversationId: null })
			.where(inArray(schema.reports.conversationId, conversationIds));
		// Conversation content that IS cleared.
		await tx.delete(schema.files).where(inArray(schema.files.conversationId, conversationIds));
		await tx
			.delete(schema.generations)
			.where(inArray(schema.generations.conversationId, conversationIds));
		await tx
			.delete(schema.abortedGenerations)
			.where(inArray(schema.abortedGenerations.conversationId, conversationIds));
		// mcp_elicitations (CUR-1017) can hold a real user answer (content), not just a transient
		// marker like abortedGenerations above — delete outright rather than leave it to the TTL
		// sweep, same treatment as files/generations.
		await tx
			.delete(schema.mcpElicitations)
			.where(inArray(schema.mcpElicitations.conversationId, conversationIds));
		const deleted = await tx
			.delete(schema.conversations)
			.where(inArray(schema.conversations.id, conversationIds))
			.returning({ id: schema.conversations.id });
		return deleted.length;
	});
	await agentCleanup;
	return deletedCount;
}

/** The conversations among `conversationIds` that began as a guest's, grouped by that guest session. */
async function formerGuestSessions(conversationIds: string[]): Promise<Map<string, string[]>> {
	const formerGuest = sql<string | null>`${schema.conversations.doc}->>'formerGuestSessionId'`;
	const rows = await getDb()
		.select({ id: schema.conversations.id, formerGuest })
		.from(schema.conversations)
		.where(inArray(schema.conversations.id, conversationIds));
	const bySession = new Map<string, string[]>();
	for (const { id, formerGuest: sid } of rows) {
		if (sid) bySession.set(sid, [...(bySession.get(sid) ?? []), id]);
	}
	return bySession;
}
