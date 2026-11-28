// Connecting a person's own MCP server that runs the MCP authorization flow. The SDK's
// `auth()` does the protocol; this file binds it to one server row and the person who owns it, and
// keeps every request it makes to the authorization server behind the strict SSRF guard. Each entry
// point takes the fetch to use, which is that guard unless a stand-in fault chose otherwise
// (oauthE2eStub.ts `mcpOAuthFetchFor`).
import { auth, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { CHAT_API_PATH } from "$lib/chat/paths";
import { ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import { SealedSecretError, credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";
import { saveUserMcpServerOAuth, type UserMcpServerRow } from "$lib/chat/server/db/userMcpServers";
import { openOAuthState, RowOAuthProvider, sealOAuthState, type McpOAuthState } from "./oauthProvider";
import type { FetchLike } from "./servers";

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
export async function serverUsesOAuth(url: string, fetchFn: FetchLike = ssrfStrictFetch): Promise<boolean> {
	try {
		const meta = await discoverOAuthProtectedResourceMetadata(url, {}, fetchFn);
		return (meta.authorization_servers?.length ?? 0) > 0;
	} catch {
		return false;
	}
}

export type StartResult = { kind: "authorized" } | { kind: "redirect"; url: URL };

/** Starts (or, with tokens still good, skips) the sign-in for one of the person's servers. */
export async function startMcpConnect(
	row: UserMcpServerRow,
	opts: { redirectUrl: string; stateParam: string; fetchFn?: FetchLike }
): Promise<StartResult> {
	const provider = providerForRow(row, opts);
	const result = await auth(provider, { serverUrl: row.url, fetchFn: opts.fetchFn ?? ssrfStrictFetch });
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
	opts: { redirectUrl: string; code: string; iss?: string; fetchFn?: FetchLike }
): Promise<void> {
	const provider = providerForRow(row, { redirectUrl: opts.redirectUrl });
	const result = await auth(provider, {
		serverUrl: row.url,
		authorizationCode: opts.code,
		...(opts.iss ? { iss: opts.iss } : {}),
		fetchFn: opts.fetchFn ?? ssrfStrictFetch,
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

/** Records that the server needs reconnecting; a failed write is logged, never thrown into the turn. */
async function markReconnect(row: UserMcpServerRow, reason: string): Promise<void> {
	logger.warn({ leg: "mcp-oauth", server: row.name, reason }, "[mcp-oauth] a server needs reconnecting; left out of this turn");
	try {
		await saveUserMcpServerOAuth(row.userId, row.id, { needsReconnect: true });
	} catch (e) {
		logger.error(
			{ leg: "mcp-oauth", server: row.name, err: e instanceof Error ? e.message : String(e) },
			"[mcp-oauth] could not mark a server for reconnecting"
		);
	}
}

/**
 * One refresh of the row's tokens through the strict SSRF guard (the turn's own fetch reaches only the
 * MCP server's origin, never the authorization server's). No browser waits on a turn, so a redirect the
 * SDK asks for here means the person must reconnect, as does a refresh that throws.
 */
async function refreshOnce(
	row: UserMcpServerRow,
	state: McpOAuthState,
	secret: string,
	fetchFn: FetchLike
): Promise<{ ok: true; state: McpOAuthState } | { ok: false; reason: string }> {
	if (!state.tokens?.refresh_token) return { ok: false, reason: "no-refresh-token" };
	// Injury: the refreshed tokens are kept in memory only and never written back to the row.
	const provider = new RowOAuthProvider({
		state: oauthStateOf(row, secret),
		redirectUrl: mcpOAuthCallbackUrl() ?? "http://localhost/unused",
		persist: async () => {},
	});
	try {
		const result = await auth(provider, { serverUrl: row.url, fetchFn });
		if (result !== "AUTHORIZED") return { ok: false, reason: "refresh-wants-consent" };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true, state: provider.current };
}

/**
 * Before a turn connects to an OAuth server: refresh its access token when it is due. Returns the row as
 * the turn should see it. A server with no tokens, or whose refresh failed or was refused, comes back
 * with `needsReconnect` set and is marked so in the database, so the turn leaves it out and Settings →
 * Connectors offers Reconnect.
 */
export async function refreshOAuthRow(
	row: UserMcpServerRow,
	now = Date.now(),
	fetchFn: FetchLike = ssrfStrictFetch
): Promise<UserMcpServerRow> {
	if (row.authKind !== "oauth" || row.needsReconnect) return row;
	const secret = credentialSecret();
	const state = oauthStateOf(row, secret);
	const reconnect = async (reason: string): Promise<UserMcpServerRow> => {
		await markReconnect(row, reason);
		return { ...row, needsReconnect: true };
	};
	if (!state.tokens?.access_token) return reconnect("no-tokens");
	if (!tokensDue(state, now)) return row;
	const refreshed = await refreshOnce(row, state, secret, fetchFn);
	if (!refreshed.ok) return reconnect(refreshed.reason);
	return { ...row, oauthState: sealOAuthState(refreshed.state, secret) };
}

/**
 * The fetch a turn reaches an OAuth server through. It sends the current access token on every request,
 * and when the server answers 401 (at connect or at a tool call) it refreshes the tokens once for the
 * whole turn and repeats that request with the new token. A refresh that fails or asks for consent, or
 * a new token the server refuses too, marks the server for reconnecting; the 401 then goes back to the
 * MCP client, which fails that request, and every later request this turn fails at once without
 * reaching the server. Nothing here throws into the turn that the turn does not already catch for any
 * unreachable server.
 *
 * `inner` is the server's origin-scoped fetch; the refresh never goes through it, since the
 * authorization server is on another origin.
 */
export function oauthServerFetch(
	row: UserMcpServerRow,
	accessToken: string,
	inner: FetchLike,
	deps: { secret?: string; onReconnectNeeded?: (rowId: string) => void; authFetch?: FetchLike } = {}
): FetchLike {
	const secret = deps.secret ?? credentialSecret();
	let access = accessToken;
	let refreshed: Promise<string | null> | undefined;
	let leftOut = false;
	const leaveOut = async (reason: string) => {
		if (leftOut) return;
		leftOut = true;
		deps.onReconnectNeeded?.(row.id);
		await markReconnect(row, reason);
	};
	const send = (input: string | URL, init: RequestInit | undefined, token: string) => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return inner(input, { ...init, headers });
	};
	return async (input, init) => {
		if (leftOut) throw new Error("[mcp-oauth] this server needs reconnecting; left out of the rest of this turn");
		const sentWith = access;
		const res = await send(input, init, sentWith);
		if (res.status !== 401) return res;
		refreshed ??= (async () => {
			const result = await refreshOnce(row, oauthStateOf(row, secret), secret, deps.authFetch ?? ssrfStrictFetch);
			if (!result.ok) {
				await leaveOut(result.reason);
				return null;
			}
			return result.state.tokens?.access_token ?? null;
		})();
		const next = await refreshed;
		// A request that already went out with the refreshed token and was still refused.
		if (!next || next === sentWith) {
			if (next) await leaveOut("refused-after-refresh");
			return res;
		}
		access = next;
		await res.body?.cancel().catch(() => {});
		const retried = await send(input, init, next);
		if (retried.status === 401) await leaveOut("refused-after-refresh");
		return retried;
	};
}
