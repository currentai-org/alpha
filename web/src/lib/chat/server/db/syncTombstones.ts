/**
 * Tombstones for /chat/api/v2/sync/changes (CUR-4312): a delete leaves no row to report, so each
 * delete made while thunderbolt-sync is on records the id here for a connected client to mirror.
 *
 * Relative imports only, so db/cleanup.ts can sweep this table under tsx (scripts/verify-cleanup.ts).
 */
import { and, asc, eq, gt, lt, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./client";
import * as schema from "./schema";

/** How long a delete stays visible to a sync client. One offline longer than this keeps its copy. */
const SYNC_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type TombstoneKind = "conversation" | "message";

export type TombstoneInput = {
	kind: TombstoneKind;
	/** Alpha's id for the deleted conversation or message. */
	entityId: string;
	/** The id a sync client pushed it under, when it was pushed; null when written in Alpha. */
	clientId?: string | null;
	/** The sync client that pushed it, or "alpha". */
	origin?: string | null;
};

export type TombstoneRow = {
	/** The tombstone's own id: the tie-break when two share a deletedAt. */
	id: string;
	kind: TombstoneKind;
	entityId: string;
	clientId: string | null;
	origin: string;
	deletedAt: Date;
};

/**
 * Record deletes for `userId` (the shadow users id). No-op for an empty list. Stamped with the clock
 * at insert, never a time read before a slow delete: /changes reads by deletedAt, so a stamp older than
 * the commit could land behind a cursor that has already passed it.
 */
export async function writeTombstones(userId: string, items: TombstoneInput[]): Promise<void> {
	const at = new Date();
	if (!items.length) return;
	await getDb()
		.insert(schema.syncTombstones)
		.values(
			items.map((i) => ({
				id: randomUUID(),
				userId,
				kind: i.kind,
				entityId: i.entityId,
				clientId: i.clientId ?? null,
				origin: i.origin ?? "alpha",
				deletedAt: at,
			}))
		);
}

/**
 * Deletes after the keyset position (`after.at`, `after.id`), oldest first, at most `limit`, and none
 * stamped later than `until`.
 */
export async function tombstonesAfter(
	userId: string,
	after: { at: number; id: string },
	until: Date,
	limit: number
): Promise<TombstoneRow[]> {
	const t = schema.syncTombstones;
	const since = new Date(after.at);
	const rows = await getDb()
		.select({ id: t.id, kind: t.kind, entityId: t.entityId, clientId: t.clientId, origin: t.origin, deletedAt: t.deletedAt })
		.from(t)
		.where(
			and(
				eq(t.userId, userId),
				or(gt(t.deletedAt, since), and(eq(t.deletedAt, since), gt(t.id, after.id))),
				lte(t.deletedAt, until)
			)
		)
		.orderBy(asc(t.deletedAt), asc(t.id))
		.limit(limit);
	return rows.map((r) => ({ ...r, kind: r.kind as TombstoneKind }));
}

/** The nightly sweep: tombstones older than the retention window. Returns how many went. */
export async function sweepSyncTombstones(now: Date): Promise<number> {
	const cutoff = new Date(now.getTime() - SYNC_TOMBSTONE_RETENTION_MS);
	const gone = await getDb()
		.delete(schema.syncTombstones)
		.where(lt(schema.syncTombstones.deletedAt, cutoff))
		.returning({ id: schema.syncTombstones.id });
	return gone.length;
}
