/**
 * Upserts the committed sync clients (config/thunderbolt.ts) into `oauth_client` when Better Auth starts
 * (CUR-4312). The oauth-provider plugin reads a client from that table on every authorize and token
 * call, and the token tables' foreign keys need the row, so the committed list has to be there before
 * the first request. Nobody can register a client any other way: betterAuth.ts's `clientPrivileges`
 * refuses every create.
 *
 * A failed upsert is logged and never thrown, because a plugin `init` that throws takes down every
 * sign-in method with it (betterAuth.ts, the genericOAuth note). Sync then fails at its own authorize
 * step with "client not found", and sign-in keeps working.
 */
import type { BetterAuthPlugin } from "better-auth";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";
import { SYNC_CLIENTS, SYNC_SCOPE, type SyncClient } from "../../../../../config/thunderbolt";

/** The `oauth_client` row for a committed sync client: public, PKCE required, consent always asked. */
function syncClientRow(c: SyncClient, now: Date) {
	return {
		id: `sync-${c.clientId}`,
		clientId: c.clientId,
		clientSecret: null,
		disabled: false,
		skipConsent: false,
		name: c.label,
		uri: c.origin,
		redirectUris: c.redirectUris,
		tokenEndpointAuthMethod: "none",
		applicationType: "web",
		grantTypes: ["authorization_code", "refresh_token"],
		responseTypes: ["code"],
		scopes: [SYNC_SCOPE, "offline_access"],
		requirePKCE: true,
		createdAt: now,
		updatedAt: now,
	};
}

async function upsertSyncClients(now = new Date()): Promise<number> {
	const db = getDb();
	for (const c of SYNC_CLIENTS) {
		const row = syncClientRow(c, now);
		// `disabled` is set on insert only, so a client switched off in the database stays off across
		// cold starts: that column is the kill switch for one client (CUR-4315).
		const { id: _id, clientId: _clientId, createdAt: _createdAt, disabled: _disabled, ...update } = row;
		await db.insert(schema.oauthClient).values(row).onConflictDoUpdate({ target: schema.oauthClient.clientId, set: update });
	}
	return SYNC_CLIENTS.length;
}

export function syncClientsPlugin(): BetterAuthPlugin {
	return {
		id: "alpha-sync-clients",
		init: async () => {
			try {
				await upsertSyncClients();
			} catch (err) {
				logger.error({ err }, "[sync] could not register the sync clients; sync authorize will fail (CUR-4312)");
			}
		},
	};
}
