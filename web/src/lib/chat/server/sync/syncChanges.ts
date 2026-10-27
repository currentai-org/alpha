/**
 * One page of /chat/api/v2/sync/changes (CUR-4312): conversations changed and rows deleted after the
 * cursor, for one account. Wire contract: syncWire.ts.
 *
 * Each stream pages in (time, id) keyset order, so rows sharing a millisecond are split across pages
 * without one being skipped. Nothing stamped within SYNC_SAFETY_LAG_MS of now is sent yet: a write
 * stamped a moment before it commits would otherwise land behind a cursor that has already passed
 * its time. The next poll picks it up.
 */
import type { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { tombstonesAfter } from "$lib/chat/server/db/syncTombstones";
import type { Conversation } from "$lib/chat/types/Conversation";
import { SYNC_WIRE_VERSION, encodeCursor, toConversationV1, type ChangesEventV1, type SyncCursor } from "./syncWire";

const CHANGES_PAGE = 50;
const SYNC_SAFETY_LAG_MS = 2_000;

type ReadOptions = { page?: number; now?: Date };

/** Conversations after (`after.at`, `after.id`), oldest first, none newer than `until`. */
async function conversationsAfter(userId: ObjectId, after: SyncCursor["conv"], until: Date, page: number) {
	const since = new Date(after.at);
	// Two queries in place of one `(updatedAt, _id) > (at, id)`: docStore has no $or. The rows at the
	// cursor's own millisecond come first, then everything later.
	const sameMs = (await collections.conversations
		.find({ userId, updatedAt: since, _id: { $gt: after.id } })
		.sort({ _id: 1 })
		.limit(page)
		.toArray()) as Conversation[];
	const later =
		sameMs.length < page
			? ((await collections.conversations
					.find({ userId, updatedAt: { $gt: since, $lte: until } })
					.sort({ updatedAt: 1, _id: 1 })
					.limit(page - sameMs.length)
					.toArray()) as Conversation[])
			: [];
	return [...sameMs, ...later];
}

export async function readChanges(
	userId: ObjectId,
	cursor: SyncCursor,
	{ page = CHANGES_PAGE, now = new Date() }: ReadOptions = {}
): Promise<{ event: ChangesEventV1; more: boolean; cursor: SyncCursor }> {
	const until = new Date(now.getTime() - SYNC_SAFETY_LAG_MS);
	const [convs, tombs] = await Promise.all([
		// The cursor never passes `until`, so the same-millisecond query cannot reach past it.
		conversationsAfter(userId, cursor.conv, until, page),
		tombstonesAfter(userId.toString(), cursor.tomb, until, page),
	]);
	const lastConv = convs.at(-1);
	const lastTomb = tombs.at(-1);
	const next: SyncCursor = {
		conv: lastConv ? { at: new Date(lastConv.updatedAt).getTime(), id: lastConv._id.toString() } : cursor.conv,
		tomb: lastTomb ? { at: lastTomb.deletedAt.getTime(), id: lastTomb.id } : cursor.tomb,
	};
	return {
		more: convs.length === page || tombs.length === page,
		cursor: next,
		event: {
			v: SYNC_WIRE_VERSION,
			cursor: encodeCursor(next),
			conversations: convs.map(toConversationV1),
			tombstones: tombs.map((t) => ({
				kind: t.kind,
				id: t.entityId,
				clientId: t.clientId,
				origin: t.origin,
				deletedAt: t.deletedAt.toISOString(),
			})),
		},
	};
}
