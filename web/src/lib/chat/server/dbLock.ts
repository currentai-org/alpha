/**
 * Minimal DB-backed advisory lock over the `semaphores` collection.
 *
 * Used at runtime by OAuth token-refresh in auth.ts to avoid concurrent refreshes across instances.
 * The lock lives in the document-store semaphore collection, not in a Postgres advisory lock or an
 * `expires_at` row.
 */
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";

const LOCK_TTL_MS = 30_000;

/** Try to acquire the lock for `key`. Returns the lock id on success, or null if already held. */
export async function acquireLock(key: string): Promise<ObjectId | null> {
	try {
		const _id = new ObjectId();
		await collections.semaphores.insertOne({
			_id,
			key,
			createdAt: new Date(),
			updatedAt: new Date(),
			deleteAt: new Date(Date.now() + LOCK_TTL_MS),
		} as never);
		return _id;
	} catch {
		// Duplicate key (unique index on `key`) → someone else holds it.
		return null;
	}
}

/** Release a lock previously acquired with `acquireLock`. */
export async function releaseLock(key: string, lockId: ObjectId): Promise<void> {
	try {
		await collections.semaphores.deleteOne({ _id: lockId, key } as never);
	} catch (err) {
		logger.error(err, "Error releasing lock");
		void captureServerException(err);
	}
}

/** Whether `key` is currently locked. */
export async function isDBLocked(key: string): Promise<boolean> {
	const count = await collections.semaphores.countDocuments({ key } as never);
	return count > 0;
}
