/**
 * What Alpha's own edit routes record for a connected sync client (CUR-4312), only while
 * thunderbolt-sync is on for the signed-in account. /chat/api/v2/sync/changes reads conversations by
 * `updatedAt`, so a rename or a deleted message has to move it, and a deleted row leaves a tombstone.
 * With the flag off nothing changes: a deleted message still leaves the list order alone.
 */
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { thunderboltSyncEnabled } from "$lib/chat/server/dataPortability";
import { writeTombstones } from "$lib/chat/server/db/syncTombstones";
import { logger } from "$lib/chat/server/logger";

function syncing(locals: App.Locals): string | null {
	const userId = locals.user?._id?.toString();
	return userId && thunderboltSyncEnabled() ? userId : null;
}

/** `{ updatedAt: now }` while sync is on for this account, else nothing: spread it into a save. */
export function syncBump(locals: App.Locals, now = new Date()): { updatedAt?: Date } {
	return syncing(locals) ? { updatedAt: now } : {};
}

type DeletedConversation = Pick<Conversation, "_id" | "syncClientId" | "syncOrigin">;

/** Tombstones for conversations just deleted. Never throws: the delete has already happened. */
export async function tombstoneConversations(locals: App.Locals, convs: DeletedConversation[]): Promise<void> {
	const userId = syncing(locals);
	if (!userId || !convs.length) return;
	await writeTombstones(
		userId,
		convs.map((c) => ({ kind: "conversation", entityId: c._id.toString(), clientId: c.syncClientId, origin: c.syncOrigin }))
	).catch((err) => logger.warn({ err }, "[sync] conversation tombstones not written"));
}

/** Tombstones for the messages a delete removed (`before` less `after`). Never throws. */
export async function tombstoneMessages(locals: App.Locals, before: Message[], after: Message[]): Promise<void> {
	const userId = syncing(locals);
	if (!userId) return;
	const kept = new Set(after.map((m) => m.id));
	const gone = before.filter((m) => !kept.has(m.id) && m.from !== "system");
	if (!gone.length) return;
	await writeTombstones(
		userId,
		gone.map((m) => ({ kind: "message", entityId: m.id, clientId: m.syncClientId, origin: m.origin }))
	).catch((err) => logger.warn({ err }, "[sync] message tombstones not written"));
}
