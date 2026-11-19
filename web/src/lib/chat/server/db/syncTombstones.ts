/**
 * The nightly sweep of `sync_tombstones`, the table Thunderbolt sync (now removed) wrote deletes
 * to. Nothing writes it any more; the sweep stays so the rows left behind still age out at 30 days,
 * until the migration that drops the table.
 *
 * Relative imports only, so db/cleanup.ts can sweep this table under tsx (scripts/verify-cleanup.ts).
 */
import { lt } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";

const SYNC_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The nightly sweep: tombstones older than the retention window. Returns how many went. */
export async function sweepSyncTombstones(now: Date): Promise<number> {
	const cutoff = new Date(now.getTime() - SYNC_TOMBSTONE_RETENTION_MS);
	const gone = await getDb()
		.delete(schema.syncTombstones)
		.where(lt(schema.syncTombstones.deletedAt, cutoff))
		.returning({ id: schema.syncTombstones.id });
	return gone.length;
}
