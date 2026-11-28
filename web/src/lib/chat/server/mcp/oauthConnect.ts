// Connecting a person's own MCP server that runs the MCP authorization flow. The SDK's
// `auth()` does the protocol; this file binds it to one server row and the person who owns it, and
// keeps every request it makes to the authorization server behind the strict SSRF guard.
import { auth, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { CHAT_API_PATH } from "$lib/chat/paths";
import { ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import { SealedSecretError, credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";
import { saveUserMcpServerOAuth, type UserMcpServerRow } from "$lib/chat/server/db/userMcpServers";
import { openOAuthState, RowOAuthProvider, sealOAuthState, type McpOAuthState } from "./oauthProvider";

/** The cookie carrying one connect's state and server id to the callback, bound to the account. */
export const MCP_CONNECT_COOKIE = "mcp_connect";
/** The provider returns to `/chat/api/...` on every surface, so the cookie's path does too. */
export const MCP_CONNECT_COOKIE_PATH = `${CHAT_API_PATH}/connectors/mcp`;

/** Our redirect URI, on the operator's public origin, or null while PUBLIC_ORIGIN is unset. */
export function mcpOAuthCallbackUrl(): string | null {
	const origin = config.PUBLIC_ORIGIN;
	return origin ? `${origin.replace(/\/+$/, "")}${MCP_CONNECT_COOKIE_PATH}/callback` : null;
}

/** The row's sign-in state; a blob that no longer opens counts as none, so a reconnect starts clean. */
export function oauthStateOf(row: UserMcpServerRow, secret = credentialSecret()): McpOAuthState {
	if (!row.oauthState) return {};
	try {
		return openOAuthState(row.oauthState, secret);
	} catch (e) {
		if (!(e instanceof SealedSecretError)) throw e;
		logger.error({ leg: "mcp-oauth", server: row.name }, "[mcp-oauth] a server's sign-in state no longer opens");
		return {};
	}
}

/** A provider over the row that writes every change back to it, sealed. */
export function providerForRow(
	row: UserMcpServerRow,
	opts: { redirectUrl: string; stateParam?: string; secret?: string }
): RowOAuthProvider {
	const secret = opts.secret ?? credentialSecret();
	return new RowOAuthProvider({
		state: oauthStateOf(row, secret),
		redirectUrl: opts.redirectUrl,
		stateParam: opts.stateParam,
		persist: (state) => saveUserMcpServerOAuth(row.userId, row.id, { oauthState: sealOAuthState(state, secret) }),
	});
}

/**
 * Whether a server URL runs the MCP authorization flow: it publishes protected-resource metadata
 * (RFC 9728). Checked when a server is added without a token. A server that answers nothing usable is
 * treated as needing no sign-in, which is what it was before this existed.
 */
export async function serverUsesOAuth(url: string): Promise<boolean> {
	try {
		const meta = await discoverOAuthProtectedResourceMetadata(url, {}, ssrfStrictFetch);
		return (meta.authorization_servers?.length ?? 0) > 0;
	} catch {
		return false;
	}
}

export type StartResult = { kind: "authorized" } | { kind: "redirect"; url: URL };

/** Starts (or, with tokens still good, skips) the sign-in for one of the person's servers. */
export async function startMcpConnect(
	row: UserMcpServerRow,
	opts: { redirectUrl: string; stateParam: string }
): Promise<StartResult> {
	const provider = providerForRow(row, opts);
	const result = await auth(provider, { serverUrl: row.url, fetchFn: ssrfStrictFetch });
	if (result === "AUTHORIZED") {
		await saveUserMcpServerOAuth(row.userId, row.id, { needsReconnect: false });
		return { kind: "authorized" };
	}
	if (!provider.authorizationUrl) throw new Error("mcp oauth: the SDK asked for a redirect without a URL");
	return { kind: "redirect", url: provider.authorizationUrl };
}

/** Trades the code the provider sent back for tokens, and clears the reconnect mark. */
export async function finishMcpConnect(
	row: UserMcpServerRow,
	opts: { redirectUrl: string; code: string; iss?: string }
): Promise<void> {
	const provider = providerForRow(row, { redirectUrl: opts.redirectUrl });
	const result = await auth(provider, {
		serverUrl: row.url,
		authorizationCode: opts.code,
		...(opts.iss ? { iss: opts.iss } : {}),
		fetchFn: ssrfStrictFetch,
	});
	if (result !== "AUTHORIZED") throw new Error("mcp oauth: the code exchange did not authorize");
	await saveUserMcpServerOAuth(row.userId, row.id, { needsReconnect: false });
}

/** Refresh this long before the access token's stated expiry, so a turn never starts on a dying token. */
const REFRESH_MARGIN_MS = 60_000;

/** True when the tokens have a stated lifetime and it ends within the margin. */
export function tokensDue(state: McpOAuthState, now = Date.now()): boolean {
	const lifetime = state.tokens?.expires_in;
	if (!lifetime || !state.tokensSavedAt) return false;
	return state.tokensSavedAt + lifetime * 1000 - REFRESH_MARGIN_MS <= now;
}

/**
 * Before a turn connects to an OAuth server: refresh its access token when it is due, through the
 * strict SSRF guard (the turn's own fetch reaches only the MCP server's origin, never the
 * authorization server's). Returns the row as the turn should see it. A server with no tokens, or
 * whose refresh failed or was refused, comes back with `needsReconnect` set and is marked so in the
 * database, so the turn leaves it out and Settings → Connectors offers Reconnect.
 */
export async function refreshOAuthRow(row: UserMcpServerRow, now = Date.now()): Promise<UserMcpServerRow> {
	if (row.authKind !== "oauth" || row.needsReconnect) return row;
	const secret = credentialSecret();
	const state = oauthStateOf(row, secret);
	const markReconnect = async (reason: string): Promise<UserMcpServerRow> => {
		logger.warn({ leg: "mcp-oauth", server: row.name, reason }, "[mcp-oauth] a server needs reconnecting; left out of this turn");
		await saveUserMcpServerOAuth(row.userId, row.id, { needsReconnect: true });
		return { ...row, needsReconnect: true };
	};
	if (!state.tokens?.access_token) return markReconnect("no-tokens");
	if (!tokensDue(state, now)) return row;
	if (!state.tokens.refresh_token) return markReconnect("expired-no-refresh-token");
	// No browser waits on a turn: a redirect the SDK asks for here means the person must reconnect.
	const provider = providerForRow(row, { redirectUrl: mcpOAuthCallbackUrl() ?? "http://localhost/unused", secret });
	try {
		const result = await auth(provider, { serverUrl: row.url, fetchFn: ssrfStrictFetch });
		if (result !== "AUTHORIZED") return markReconnect("refresh-wants-consent");
	} catch (e) {
		return markReconnect(e instanceof Error ? e.message : String(e));
	}
	return { ...row, oauthState: sealOAuthState(provider.current, secret) };
}
