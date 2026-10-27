/**
 * Settings → Connections (CUR-4312): the sync clients an account has allowed, and Disconnect. A
 * connection is an `oauth_consent` row for a registered client (config/thunderbolt.ts); Disconnect
 * deletes the consent and every access and refresh token that client holds for the account, so its
 * next request is a 401 and its next authorize asks again.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { SYNC_CLIENTS, syncClientById } from "../../../../../config/thunderbolt";

export type SyncConnection = { clientId: string; label: string; host: string; since: string };

const registered = SYNC_CLIENTS.map((c) => c.clientId);

export async function listSyncConnections(betterAuthUserId: string): Promise<SyncConnection[]> {
	const rows = await getDb()
		.select({ clientId: schema.oauthConsent.clientId, createdAt: schema.oauthConsent.createdAt })
		.from(schema.oauthConsent)
		.where(and(eq(schema.oauthConsent.userId, betterAuthUserId), inArray(schema.oauthConsent.clientId, registered)))
		.orderBy(schema.oauthConsent.createdAt);
	const seen = new Set<string>();
	return rows.flatMap((r) => {
		const c = syncClientById(r.clientId);
		if (!c || seen.has(c.clientId)) return [];
		seen.add(c.clientId);
		return [{ clientId: c.clientId, label: c.label, host: new URL(c.origin).host, since: r.createdAt.toISOString() }];
	});
}

/** Removes the consent and the tokens. Returns whether anything was connected. */
export async function disconnectSyncClient(betterAuthUserId: string, clientId: string): Promise<boolean> {
	if (!syncClientById(clientId)) return false;
	const db = getDb();
	return db.transaction(async (tx) => {
		await tx
			.delete(schema.oauthAccessToken)
			.where(and(eq(schema.oauthAccessToken.userId, betterAuthUserId), eq(schema.oauthAccessToken.clientId, clientId)));
		await tx
			.delete(schema.oauthRefreshToken)
			.where(and(eq(schema.oauthRefreshToken.userId, betterAuthUserId), eq(schema.oauthRefreshToken.clientId, clientId)));
		const gone = await tx
			.delete(schema.oauthConsent)
			.where(and(eq(schema.oauthConsent.userId, betterAuthUserId), eq(schema.oauthConsent.clientId, clientId)))
			.returning({ id: schema.oauthConsent.id });
		return gone.length > 0;
	});
}
