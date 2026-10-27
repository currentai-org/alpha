/**
 * per-user storage location rows and the default-location choice (schema.ts's
 * `storage_locations`, `storage_preferences`). Plain drizzle, same shape as localInferenceEndpoints.ts.
 *
 * Every read, update and delete scopes by `userId` in the query itself, never by id alone: the id
 * space is opaque but not secret, and this check is what keeps one account off another's location. (CUR-2930)
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { storageLocations, storagePreferences, type StorageLocationConfig, type StorageLocationRow } from "./schema";
import { newId } from "./ids";

export type { StorageLocationRow, StorageLocationConfig };

export async function listStorageLocations(userId: string): Promise<StorageLocationRow[]> {
	return getDb()
		.select()
		.from(storageLocations)
		.where(eq(storageLocations.userId, userId))
		.orderBy(storageLocations.createdAt);
}

export async function getStorageLocation(userId: string, id: string): Promise<StorageLocationRow | null> {
	const rows = await getDb()
		.select()
		.from(storageLocations)
		.where(and(eq(storageLocations.userId, userId), eq(storageLocations.id, id)))
		.limit(1);
	return rows[0] ?? null;
}

export async function createStorageLocation(input: {
	userId: string;
	kind: string;
	label: string;
	config: StorageLocationConfig;
	credential: string;
}): Promise<StorageLocationRow> {
	const [row] = await getDb()
		.insert(storageLocations)
		.values({ ...input, id: newId(), status: "ok", verifiedAt: new Date() })
		.returning();
	return row;
}

export async function setStorageLocationStatus(
	userId: string,
	id: string,
	status: "ok" | "needs-reconnect",
	lastError: string | null
): Promise<void> {
	await getDb()
		.update(storageLocations)
		.set({ status, lastError, ...(status === "ok" ? { verifiedAt: new Date() } : {}) })
		.where(and(eq(storageLocations.userId, userId), eq(storageLocations.id, id)));
}

/** Replaces a location's sealed credential, after an OAuth refresh hands back new tokens (CUR-2932). */
export async function setStorageLocationCredential(userId: string, id: string, credential: string): Promise<void> {
	await getDb()
		.update(storageLocations)
		.set({ credential })
		.where(and(eq(storageLocations.userId, userId), eq(storageLocations.id, id)));
}

/** @returns whether a row was deleted. Clears the default and the last-used location too when either
 *  pointed here, so neither names a place that is gone. */
export async function deleteStorageLocation(userId: string, id: string): Promise<boolean> {
	const deleted = await getDb()
		.delete(storageLocations)
		.where(and(eq(storageLocations.userId, userId), eq(storageLocations.id, id)))
		.returning({ id: storageLocations.id });
	if (deleted.length === 0) return false;
	await getDb()
		.update(storagePreferences)
		.set({ defaultLocation: null, updatedAt: new Date() })
		.where(and(eq(storagePreferences.userId, userId), eq(storagePreferences.defaultLocation, id)));
	await getDb()
		.update(storagePreferences)
		.set({ lastUsedLocation: null })
		.where(and(eq(storagePreferences.userId, userId), eq(storagePreferences.lastUsedLocation, id)));
	return true;
}

/** `defaultLocation`: null = "Last used" (never chosen), "alpha", "ask", else a storage_locations id.
 *  `lastUsedLocation`: where the most recent upload went, null before the first. */
export async function getStoragePreferences(
	userId: string
): Promise<{ defaultLocation: string | null; lastUsedLocation: string | null }> {
	const rows = await getDb()
		.select({ defaultLocation: storagePreferences.defaultLocation, lastUsedLocation: storagePreferences.lastUsedLocation })
		.from(storagePreferences)
		.where(eq(storagePreferences.userId, userId))
		.limit(1);
	return rows[0] ?? { defaultLocation: null, lastUsedLocation: null };
}

/** Records where an upload just went, for "Last used". Leaves the chosen default alone. (CUR-3077) */
export async function setLastUsedStorageLocation(userId: string, locationId: string): Promise<void> {
	await getDb()
		.insert(storagePreferences)
		.values({ userId, lastUsedLocation: locationId, updatedAt: new Date() })
		.onConflictDoUpdate({ target: storagePreferences.userId, set: { lastUsedLocation: locationId } });
}

export async function setDefaultStorageLocation(userId: string, value: string | null): Promise<void> {
	await getDb()
		.insert(storagePreferences)
		.values({ userId, defaultLocation: value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: storagePreferences.userId,
			set: { defaultLocation: value, updatedAt: new Date() },
		});
}
