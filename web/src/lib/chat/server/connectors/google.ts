// Connect Google: a person's own Gmail, Calendar and Drive, read-only, reachable from chat through
// the operator's Google connector, an MCP server the self-host `google` compose profile runs
// (taylorwilsdon/google_workspace_mcp in external-provider mode; docs/research/2026-11-24-self-host-google-connector.md).
//
// Our part is the plumbing. The OAuth itself is openid-client's: discovery, PKCE, the code exchange and
// the refresh. The refresh token is sealed per person in `user_google_connections` and never leaves this
// server. Each turn trades it for a short-lived access token, which is all the connector ever receives,
// as the bearer on a fetch held to the connector's own origin. The connector holds no client secret and
// stores nothing.
import * as oidc from "openid-client";
import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { CHAT_API_PATH } from "$lib/chat/paths";
import { credentialSecret, open, seal, SealedSecretError } from "$lib/chat/server/storage/locations/sealedSecret";
import { getUserGoogleConnection, type UserGoogleConnectionRow } from "$lib/chat/server/db/userGoogleConnections";
import { originScopedFetch, type FetchLike, type McpServerConfig } from "$lib/chat/server/mcp/servers";
import type { FaultInjectionName } from "$lib/chat/server/textGeneration/faultInjection";
import { stubGoogleMcpFetch, stubGoogleOidc } from "./googleE2eStub";

/** PostHog flag key. Owner: chat. On in self-host once the three GOOGLE_* settings are set (flagKeys.ts). */
export const GOOGLE_CONNECTOR_FLAG = "google-connector";
/** The server's name, and so the `google__` prefix of its tools. Reserved: no person's own server takes it. */
export const GOOGLE_SERVER_NAME = "google";
/**
 * What Connect Google asks for: read-only Gmail, Calendar and Drive, plus who the account is. These are
 * the scopes the connector asks of each tool set when started with `--read-only` and
 * `--tools gmail calendar drive` (its auth/scopes.py, TOOL_READONLY_SCOPES_MAP). It checks them per
 * tool, so a token without Drive still serves Gmail and Calendar, and a Drive tool answers that the
 * permission is missing.
 */
export const GOOGLE_SCOPES = [
	"openid",
	"email",
	"profile",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/calendar.readonly",
	"https://www.googleapis.com/auth/drive.readonly",
];
/** Drive came after Gmail and Calendar: a connection made before it, or with Drive unticked, lacks it. */
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/** What a connect must be granted. Drive is asked for but not required, so unticking it still connects. */
const REQUIRED_SCOPES = GOOGLE_SCOPES.filter((s) => s.startsWith("https://") && s !== GOOGLE_DRIVE_SCOPE);

/** True when a stored connection's grant leaves out Drive, so the settings page offers a reconnect. */
export function googleGrantLacksDrive(scopes: string): boolean {
	return !scopes.split(/\s+/).includes(GOOGLE_DRIVE_SCOPE);
}

/** The cookie carrying one connect's state and PKCE verifier to the callback, bound to the account. */
export const GOOGLE_CONNECT_COOKIE = "google_connect";
/** Google returns to `/chat/api/...` on every surface (the registered redirect URI), so the cookie's path does too. */
export const GOOGLE_CONNECT_COOKIE_PATH = `${CHAT_API_PATH}/connectors/google`;

const ISSUER = new URL("https://accounts.google.com");
/** HKDF info for the refresh token, so no other sealed credential opens as one. */
const SEAL_INFO = "aipotluck/google-connector-credential/v1";
/** Refresh this long before Google's expiry, so a token never lapses in the middle of a turn. */
const REFRESH_EARLY_MS = 120_000;

export function googleConnectorEnabled(): boolean {
	return flagEnabledOr(GOOGLE_CONNECTOR_FLAG, () => false);
}

export type GoogleConnectApp = { clientId: string; clientSecret: string; redirectUri: string; connectorUrl: string };

/** The operator's Google client and connector, or null while any of them is unset. */
export function googleConnectApp(): GoogleConnectApp | null {
	const clientId = config.GOOGLE_CONNECT_CLIENT_ID;
	const clientSecret = config.GOOGLE_CONNECT_CLIENT_SECRET;
	const connectorUrl = config.GOOGLE_CONNECTOR_URL;
	const origin = config.PUBLIC_ORIGIN;
	if (!clientId || !clientSecret || !connectorUrl || !origin) return null;
	return {
		clientId,
		clientSecret,
		connectorUrl,
		redirectUri: `${origin.replace(/\/$/, "")}${CHAT_API_PATH}/connectors/google/callback`,
	};
}

export type OidcDeps = {
	/** openid-client's discovery, replaced in specs by a configuration built offline. */
	discover?: (app: GoogleConnectApp) => Promise<oidc.Configuration>;
};

let discovered: { clientId: string; config: Promise<oidc.Configuration> } | undefined;

function discoverGoogle(app: GoogleConnectApp): Promise<oidc.Configuration> {
	if (discovered?.clientId !== app.clientId) {
		const pending = oidc.discovery(ISSUER, app.clientId, app.clientSecret);
		// A failed discovery is not cached, so the next connect tries again.
		pending.catch(() => {
			if (discovered?.config === pending) discovered = undefined;
		});
		discovered = { clientId: app.clientId, config: pending };
	}
	return discovered.config;
}

/** A fresh state and PKCE verifier for one connect, and the consent URL that carries them. */
export async function startConnect(
	app: GoogleConnectApp,
	deps: OidcDeps = {}
): Promise<{ url: URL; state: string; verifier: string }> {
	const cfg = await (deps.discover ?? discoverGoogle)(app);
	const state = oidc.randomState();
	const verifier = oidc.randomPKCECodeVerifier();
	const url = oidc.buildAuthorizationUrl(cfg, {
		redirect_uri: app.redirectUri,
		scope: GOOGLE_SCOPES.join(" "),
		code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		state,
		// A refresh token comes back only with offline access, and only on a consent screen.
		access_type: "offline",
		prompt: "consent",
	});
	return { url, state, verifier };
}

export class GoogleConnectError extends Error {
	constructor(readonly reason: "no-refresh-token" | "missing-scope" | "no-email") {
		super(`Google connect refused: ${reason}`);
	}
}

/**
 * Trades the callback's code for tokens (openid-client checks the state, the PKCE verifier and the ID
 * token) and returns what to store. Refuses a grant without a refresh token, without Gmail and Calendar
 * read-only (the person can untick one on Google's consent screen), or without an email to show. Drive
 * may be unticked: the connection then serves Gmail and Calendar, and the settings page offers a
 * reconnect for Drive.
 */
export async function finishConnect(
	app: GoogleConnectApp,
	callbackUrl: URL,
	expected: { state: string; verifier: string },
	deps: OidcDeps = {}
): Promise<{ refreshToken: string; email: string; scopes: string }> {
	const cfg = await (deps.discover ?? discoverGoogle)(app);
	const tokens = await oidc.authorizationCodeGrant(cfg, callbackUrl, {
		pkceCodeVerifier: expected.verifier,
		expectedState: expected.state,
	});
	if (!tokens.refresh_token) throw new GoogleConnectError("no-refresh-token");
	const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
	if (!REQUIRED_SCOPES.every((s) => granted.includes(s))) throw new GoogleConnectError("missing-scope");
	const email = tokens.claims()?.email;
	if (typeof email !== "string" || !email) throw new GoogleConnectError("no-email");
	return { refreshToken: tokens.refresh_token, email, scopes: granted.join(" ") };
}

export function sealRefreshToken(token: string, secret = credentialSecret()): string {
	return seal(token, secret, SEAL_INFO);
}

type CachedToken = { credential: string; accessToken: string; expiresAt: number };
/** Access tokens by account, each tied to the sealed credential it came from, so a reconnect drops it. */
const accessTokens = new Map<string, CachedToken>();

type AccessDeps = OidcDeps & {
	secret?: string;
	now?: () => number;
	refresh?: (cfg: oidc.Configuration, refreshToken: string) => Promise<oidc.TokenEndpointResponse>;
};

/** A live access token for this person's connection, refreshed only when the cached one is near expiry. */
export async function accessTokenFor(
	app: GoogleConnectApp,
	row: UserGoogleConnectionRow,
	deps: AccessDeps = {}
): Promise<string> {
	const now = (deps.now ?? Date.now)();
	const cached = accessTokens.get(row.userId);
	if (cached && cached.credential === row.credential && cached.expiresAt - REFRESH_EARLY_MS > now) {
		return cached.accessToken;
	}
	const refreshToken = open(row.credential, deps.secret ?? credentialSecret(), SEAL_INFO);
	const cfg = await (deps.discover ?? discoverGoogle)(app);
	const res = await (deps.refresh ?? ((c, t) => oidc.refreshTokenGrant(c, t)))(cfg, refreshToken);
	// Google's access tokens last an hour; without an expires_in, assume the shortest sane life.
	const expiresIn = typeof res.expires_in === "number" ? res.expires_in : 300;
	accessTokens.set(row.userId, { credential: row.credential, accessToken: res.access_token, expiresAt: now + expiresIn * 1000 });
	return res.access_token;
}

/** Forgets the cached access token, for a disconnect. */
export function forgetAccessToken(userId: string): void {
	accessTokens.delete(userId);
}

let warnedUnconfigured = false;

export type ServerDeps = AccessDeps & {
	read?: (userId: string) => Promise<UserGoogleConnectionRow | null>;
	baseFetch?: FetchLike;
	app?: GoogleConnectApp | null;
	enabled?: () => boolean;
};

/**
 * Under the `google_connector_stub` fault, Google and the connector are answered in-process
 * (googleE2eStub.ts), so a spec connects, refreshes and calls Drive tools with no Google account. Any
 * other fault, or none, leaves the real ones. The fault arrives here only after faultInjection.ts's
 * gate passed: a test deployment and the HMAC fault token.
 */
export function googleFaultDeps(faultInjection: FaultInjectionName | null | undefined): Pick<ServerDeps, "discover" | "baseFetch"> {
	if (faultInjection !== "google_connector_stub") return {};
	return { discover: stubGoogleOidc(GOOGLE_SCOPES), baseFetch: stubGoogleMcpFetch };
}

/**
 * The connector as one more MCP server for this person's turn, carrying their access token. Null for a
 * guest, with the flag off, with nothing connected, or when the refresh fails (Google refused it, or
 * the sealing secret rotated). Each failure is logged and leaves the turn without Google rather than
 * failing it.
 */
export async function googleServerFor(
	locals: App.Locals | undefined,
	given: ServerDeps = {},
	faultInjection?: FaultInjectionName | null
): Promise<McpServerConfig | null> {
	const deps: ServerDeps = { ...googleFaultDeps(faultInjection), ...given };
	if (!(deps.enabled ?? googleConnectorEnabled)()) return null;
	const userId = locals?.user?._id?.toString();
	if (!userId) return null;
	const app = deps.app !== undefined ? deps.app : googleConnectApp();
	if (!app) {
		// The flag is on and the config is not there: a misconfiguration, said once and loudly.
		if (!warnedUnconfigured) {
			warnedUnconfigured = true;
			logger.error(
				{ leg: "google-connector" },
				"[google-connector] the flag is on but GOOGLE_CONNECT_CLIENT_ID, GOOGLE_CONNECT_CLIENT_SECRET, GOOGLE_CONNECTOR_URL or PUBLIC_ORIGIN is unset; Google is not offered"
			);
		}
		return null;
	}
	let row: UserGoogleConnectionRow | null;
	try {
		row = await (deps.read ?? getUserGoogleConnection)(userId);
	} catch (e) {
		logger.warn(
			{ leg: "google-connector", err: e instanceof Error ? e.message : String(e) },
			"[google-connector] could not read the connection; Google is left out of this turn"
		);
		return null;
	}
	if (!row) return null;
	let token: string;
	try {
		token = await accessTokenFor(app, row, deps);
	} catch (e) {
		const reason =
			e instanceof SealedSecretError
				? "the sealed refresh token no longer opens"
				: e instanceof oidc.ResponseBodyError
					? `Google refused the refresh (${e.error})`
					: e instanceof Error
						? e.message
						: String(e);
		logger.warn(
			{ leg: "google-connector", reason },
			"[google-connector] no access token for a connected account; Google is left out of this turn"
		);
		return null;
	}
	const origin = new URL(app.connectorUrl).origin;
	return {
		name: GOOGLE_SERVER_NAME,
		url: app.connectorUrl,
		headers: { Authorization: `Bearer ${token}` },
		origin,
		// The operator names this address, on the compose network, so a private one: it takes the plain
		// fetch the agent service's address does, still held to its own origin across redirects.
		fetch: originScopedFetch(origin, deps.baseFetch ?? fetch),
	};
}
