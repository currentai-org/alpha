/**
 * The OAuth clients registered for conversation sync (CUR-4312), committed rather than created through
 * an endpoint: nobody can register a client at runtime (clientPrivileges in betterAuth.ts refuses
 * every create), so this list is the whole set. Each entry is upserted into `oauth_client` when Better
 * Auth starts (syncClients.ts).
 *
 * Public PKCE clients only: no secret,
 * S256 required, and a token they hold authenticates /chat/api/v2/sync/* and nothing else.
 *
 * No `$lib` or server imports, so the chat client can read `label` for the "Written in …" mark.
 */

/** The one scope a sync token carries. `offline_access` beside it gets a refresh token. */
export const SYNC_SCOPE = "conversations:sync";

export type SyncClient = {
	/** OAuth client_id, and the `origin` stamped on every message it pushes. */
	clientId: string;
	/** Shown on the consent page, the Connections list and the provenance mark. */
	label: string;
	/** The browser origin the client runs on: the only origin CORS answers for it. */
	origin: string;
	redirectUris: string[];
};

export const SYNC_CLIENTS: readonly SyncClient[] = [
	{
		clientId: "thunderbolt-sandbox",
		label: "Thunderbolt",
		origin: "https://thunderbolt.example.org",
		redirectUris: ["https://thunderbolt.example.org/oauth/alpha/callback"],
	},
];

export function syncClientById(clientId: string | null | undefined): SyncClient | undefined {
	if (!clientId) return undefined;
	return SYNC_CLIENTS.find((c) => c.clientId === clientId);
}

/** Is `origin` the browser origin of a registered sync client? Exact match, scheme and port included. */
export function isSyncClientOrigin(origin: string | null | undefined): boolean {
	if (!origin) return false;
	return SYNC_CLIENTS.some((c) => c.origin === origin);
}
