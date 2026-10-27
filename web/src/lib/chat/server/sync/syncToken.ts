/**
 * Verifies a conversation-sync access token (CUR-4312). Mirrors the oauth-provider plugin's own
 * opaque-token check (validateOpaqueAccessToken in @better-auth/oauth-provider 1.7.12): strip the
 * prefix, SHA-256 the rest to base64url (the plugin's default `storeTokens: "hashed"`), find the row,
 * and refuse it when it is past its expiry or withdrawn, when its client is unknown or switched off,
 * or when the session it was issued under has ended. Read straight from the table rather than through
 * the plugin's introspection endpoint, which accepts only confidential clients.
 *
 * Signing out of Alpha does not disconnect a sync client. The plugin revokes the session's access
 * tokens on sign-out, but a refresh token holding `offline_access` outlives the session (OIDC
 * Back-Channel Logout 1.0 §2.7), so the client mints a new access token and carries on. Disconnect on
 * Settings → Connections is what ends sync (CUR-4315).
 *
 * Two refusals a caller can act on: `unauthenticated` (401: refresh and retry once) and
 * `not_permitted` (403: a live token that lacks `conversations:sync`, or one minted for a client this
 * deployment no longer lists).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { SYNC_SCOPE, syncClientById } from "../../../../../config/thunderbolt";

/** Prefixes the plugin puts on the tokens it hands out (betterAuth.ts `prefix`), never stored. */
export const SYNC_ACCESS_TOKEN_PREFIX = "alpha_sync_at_";
export const SYNC_REFRESH_TOKEN_PREFIX = "alpha_sync_rt_";

export type SyncTokenResult =
	| { ok: true; betterAuthUserId: string; emailVerified: boolean; clientId: string; scopes: string[] }
	| { ok: false; reason: "unauthenticated" | "not_permitted" };

/** The value the plugin stores for `token`: its unprefixed part, SHA-256, base64url without padding. */
export function storedSyncTokenHash(token: string): string {
	const bare = token.startsWith(SYNC_ACCESS_TOKEN_PREFIX) ? token.slice(SYNC_ACCESS_TOKEN_PREFIX.length) : token;
	return createHash("sha256").update(bare).digest("base64url");
}

export async function verifySyncAccessToken(token: string, now = new Date()): Promise<SyncTokenResult> {
	// Only a token this server minted carries the prefix; anything else (an HF token, a session id) is
	// not looked up at all.
	if (!token.startsWith(SYNC_ACCESS_TOKEN_PREFIX) || token.length <= SYNC_ACCESS_TOKEN_PREFIX.length) {
		return { ok: false, reason: "unauthenticated" };
	}
	const db = getDb();
	const [row] = await db
		.select({
			userId: schema.oauthAccessToken.userId,
			clientId: schema.oauthAccessToken.clientId,
			sessionId: schema.oauthAccessToken.sessionId,
			scopes: schema.oauthAccessToken.scopes,
			expiresAt: schema.oauthAccessToken.expiresAt,
			withdrawnAt: schema.oauthAccessToken.revoked,
			clientOff: schema.oauthClient.disabled,
			emailVerified: schema.user.emailVerified,
		})
		.from(schema.oauthAccessToken)
		.innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthAccessToken.clientId))
		.leftJoin(schema.user, eq(schema.user.id, schema.oauthAccessToken.userId))
		.where(eq(schema.oauthAccessToken.token, storedSyncTokenHash(token)))
		.limit(1);
	const no = (reason: "unauthenticated" | "not_permitted"): SyncTokenResult => ({ ok: false, reason });
	if (!row || !row.userId) return no("unauthenticated");
	if (row.withdrawnAt || row.expiresAt.getTime() <= now.getTime() || row.clientOff) return no("unauthenticated");
	if (row.sessionId) {
		const [s] = await db
			.select({ expiresAt: schema.session.expiresAt })
			.from(schema.session)
			.where(eq(schema.session.id, row.sessionId))
			.limit(1);
		if (!s || s.expiresAt.getTime() <= now.getTime()) return no("unauthenticated");
	}
	if (!row.scopes.includes(SYNC_SCOPE) || !syncClientById(row.clientId)) return no("not_permitted");
	return {
		ok: true,
		betterAuthUserId: row.userId,
		emailVerified: row.emailVerified === true,
		clientId: row.clientId,
		scopes: row.scopes,
	};
}
