import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import {
	discovery,
	refreshTokenGrant,
	clockTolerance,
	ClientSecretPost,
	None,
	Configuration,
	type ClientMetadata,
	type ServerMetadata,
	type TokenEndpointResponse,
	type TokenEndpointResponseHelpers,
} from "openid-client";
// Per-function subpaths: the date-fns barrel costs ~4 s to load, paid by every spec that imports
// this file (CUR-2446).
import { addWeeks } from "date-fns/addWeeks";
import { differenceInMinutes } from "date-fns/differenceInMinutes";
import { subMinutes } from "date-fns/subMinutes";
import { config } from "$lib/chat/server/config";
import { sha256 } from "$lib/chat/utils/sha256";
import { z } from "zod";
import { dev } from "$app/environment";
import { error, type Cookies } from "@sveltejs/kit";
import { collections } from "$lib/chat/server/database";
import { withTransaction } from "$lib/chat/server/db/client";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";
import { ObjectId } from "bson";
import { getAuth } from "./betterAuth";
import { OIDConfig, loginEnabled } from "./oidcConfig";
import { migrateAnonymousConversations, migrateAnonymousSettings } from "./migrateAnonymousSession";
import { migrateAgentTrust } from "./migrateAgentTrust";
import type { User } from "$lib/chat/types/User";
import type { Session } from "$lib/chat/types/Session";
import { CHAT_API_PATH, CIMD_PATH, HF_LOGIN_CALLBACK_PATH } from "$lib/chat/paths";
import { chatRoutePath } from "$lib/surface";
import { acquireLock, isDBLocked, releaseLock } from "$lib/chat/server/dbLock";
import { Semaphores } from "$lib/chat/types/Semaphore";
import { isMintedGuestToken, mintGuestToken } from "./guestSession";
import { SYNC_ACCESS_TOKEN_PREFIX, SYNC_REFRESH_TOKEN_PREFIX, verifySyncAccessToken } from "./sync/syncToken";

export interface OIDCSettings {
	redirectURI: string;
}

/**
 * What openid-client v6 returns from a token endpoint. v5's `TokenSet` class is gone; the response is
 * now a plain object intersected with helper METHODS (`claims()`, `expiresIn()`). Those methods do not
 * survive a JSON round-trip, so this type is only safe to pass around in memory — never persist it and
 * rehydrate it. We don't: only the derived `Session["oauth"]` shape is stored.
 */
export type OIDCTokens = TokenEndpointResponse & TokenEndpointResponseHelpers;

// OIDConfig/loginEnabled moved to oidcConfig.ts (CUR-434): betterAuth.ts reuses these same values for
// its Hugging Face genericOAuth provider, and importing them from here would create a circular
// dependency now that authenticateRequest below imports the Better Auth instance from betterAuth.ts.
// Re-exported (imported above) so every existing consumer of `$lib/chat/server/auth`'s
// OIDConfig/loginEnabled is unaffected.
export { OIDConfig, loginEnabled };

export const secure = z
	.boolean()
	.default(!(dev || config.ALLOW_INSECURE_COOKIES === "true"))
	.parse(config.COOKIE_SECURE === "" ? undefined : config.COOKIE_SECURE === "true");

/**
 * `lax`, unconditionally (CUR-1645).
 *
 * A default of `none` on secure deployments would make the more secure the deployment, the weaker the
 * cookie: `COOKIE_SAMESITE` is unset in every env file, so the session cookie would go out as
 * `SameSite=None`. `lax` is also what the app's own `ap_starters_seen` cookie uses.
 *
 * `none` was a chat-ui default for a Hugging Face Space iframe. This app is served from Vercel and
 * nothing embeds it in a Space; the only HF references in `src/` are provenance links and an unrelated
 * audio-clip spec.
 *
 * `svelte.config.js` does allow two cross-site framers, `frame-ancestors: ['https://huggingface.co',
 * <CMS url>]`, and `lax` stops the cookie being sent in a third-party frame, so each was checked
 * against what an embed would need:
 *
 *   - The CMS entry is Payload's Live Preview. `payload/src/utilities/generateFrontendURL.ts` maps a
 *     document to `/`, a Pages breadcrumb URL, or `/updates/<slug>` — never `/chat` — and it proves
 *     the request is a draft by appending `CMS_PREVIEW_SECRET` as a QUERY PARAM, not by presenting a
 *     session. It has its own credential precisely because it cannot rely on one, so the session
 *     cookie is not part of that path.
 *   - The `huggingface.co` entry is the Space half, with no live consumer left to break.
 *
 * `lax` is the modern default for a first-party session cookie: still sent on the top-level
 * navigation that a cold page load IS — which is what the CUR-1645 cookie fix below depends on — and
 * not sent from a third-party context. `COOKIE_SAMESITE` still overrides, so a genuine embedded
 * deployment sets `none` explicitly rather than inheriting it by accident.
 */
export const sameSite = z
	.enum(["lax", "none", "strict"])
	.default("lax")
	.parse(config.COOKIE_SAMESITE === "" ? undefined : config.COOKIE_SAMESITE);

// Session cookie name. Unlike secure/sameSite, config has no default for COOKIE_NAME (it's a plain
// env passthrough), so when the env var is unset — e.g. on a deploy that didn't set it — config.COOKIE_NAME
// is "", and cookies.set("", …) makes cookie.serialize throw "argument name is invalid", 500-ing every
// cookie-setting POST (conversation create, settings). Default to the chat-ui heritage name so the cookie
// always has a valid name. Used for both set and read so they can't drift.
export const sessionCookieName = config.COOKIE_NAME || "hf-chat";

/**
 * Only a same-origin path survives. Browsers apply WHATWG special-scheme normalisation to a
 * `Location` header, so `/\evil.com` resolves as `https://evil.com/` — the `//` check alone let that
 * through, and `?next=/%5Cevil.com` on the login URL rode the signed OIDC state into the callback's
 * redirect as an open redirect behind a genuine sign-in. Any backslash, or any control character
 * (header injection), rejects the whole value rather than trying to repair it.
 */
export function sanitizeReturnPath(path: string | undefined | null): string | undefined {
	if (!path) {
		return undefined;
	}
	if (!path.startsWith("/") || path.startsWith("//")) {
		return undefined;
	}
	// eslint-disable-next-line no-control-regex
	if (/[\\\x00-\x1f\x7f]/.test(path)) {
		return undefined;
	}
	return path;
}

export function refreshSessionCookie(cookies: Cookies, sessionId: string) {
	cookies.set(sessionCookieName, sessionId, {
		path: "/",
		// `sameSite` defaults to lax — see its own definition above for why `none` is not the default.
		sameSite,
		secure,
		httpOnly: true,
		expires: addWeeks(new Date(), 2),
	});
}

type MintedAnonSession = { sessionId: string; secretSessionId: string };

/**
 * Mint a fresh anonymous session. No coalescing (CUR-1645).
 *
 * A cookie-less mint is not coalesced against any other cookie-less mint from the same
 * `(IP, User-Agent)` pair. `ip:userAgent` cannot tell one visitor from another, so two strangers behind
 * one NAT running the same browser build, both arriving cold inside a coalescing window, would receive
 * the SAME anonymous session and could each read or wipe the other's conversation.
 *
 * Coalescing is also unnecessary. `hooks/handle.ts` sets the cookie on any response whose request
 * minted, whatever the method, so a cold page load ends holding its cookie after its first chat-pipeline
 * request. The document navigation is not the minting request: `hooks.server.ts` routes to this
 * pipeline only for `/chat` and `/chat/**`, so `/alpha/chat` — the page a visitor actually opens — is
 * served by the site pipeline and never touches chat auth. A cold load issues exactly ONE chat-pipeline
 * request, `GET /chat/api/warm`, which mints and returns the cookie.
 *
 * What remains is narrow: two genuinely simultaneous cold tabs each mint, and the loser's own empty
 * session is orphaned to themselves, which is strictly better than a cross-user leak.
 *
 * THE SWEEP IS NOT DEAD CODE. Rows left by the retired coalescing store `secretSessionId` — the raw
 * bearer value the cookie carries — in the clear, where the `sessions` table beside them keeps only
 * sha256 of it (CUR-1325). Nothing writes them now, so this drains what is left rather than leaving
 * live credentials in a table nobody reads. It filters on `secretSessionId: {$exists: true}` rather
 * than on the retired `anon.session.mint:<ip>:<ua>` key — that `Semaphores` member is deleted, and
 * matching the shape of the row is what keeps this off the lock rows sharing this collection, which
 * carry no such field.
 *
 * There is NO `deleteAt` PREDICATE: nothing reads these rows, so every one is a plaintext credential
 * with no remaining purpose, and a predicate sparing unexpired rows would only slow the drain. Deleting
 * a row does not invalidate any session it recorded, because `sessions` is a separate table and holds
 * sha256 of the same value. The sweep can go once the table is confirmed empty on every deployment.
 */
async function mintAnonymousSession(): Promise<MintedAnonSession> {
	await collections.semaphores
		.deleteMany({ secretSessionId: { $exists: true } } as never)
		.catch(() => {});

	// signed, so a later request can tell a value we issued from one it made up. (CUR-3191)
	const secret = config.BETTER_AUTH_SECRET;
	if (!secret) warnUnsignedGuestSessions();
	const secretSessionId = secret ? mintGuestToken(secret) : crypto.randomUUID();
	const sessionId = await sha256(secretSessionId);

	if (await collections.sessions.findOne({ sessionId })) {
		throw new Error("Session ID collision");
	}

	return { sessionId, secretSessionId };
}

let warnedUnsigned = false;
/** No secret means guest cookies cannot be signed, so any value is accepted as before. Said once per
 *  instance at error level: every per-session limit is resettable while this holds. */
function warnUnsignedGuestSessions(): void {
	if (warnedUnsigned) return;
	warnedUnsigned = true;
	logger.error(
		"[auth] BETTER_AUTH_SECRET is not set, so guest sessions are unsigned and any cookie value is accepted as one (CUR-3191)"
	);
}

/**
 * Whether a guest cookie (one with no `sessions` row) is kept as the session.
 *
 * A value this deployment signed is kept. An unsigned value is kept only when a conversation or a
 * setting is already saved under it: those are guests whose cookie predates signing, and re-minting
 * them would orphan their history. Any other value is one the server never issued, and the caller
 * gets a fresh minted session instead, so a made-up cookie no longer starts a new per-session
 * rate-limit budget. An unrecognised cookie cannot gain rows, because it is re-minted before
 * anything is written under it. (CUR-3191)
 */
async function keepGuestCookie(token: string, sessionId: string): Promise<boolean> {
	const secret = config.BETTER_AUTH_SECRET;
	if (!secret) {
		warnUnsignedGuestSessions();
		return true;
	}
	if (isMintedGuestToken(token, secret)) return true;
	return guestSessionOwnsData(sessionId);
}

/**
 * Whether anything is saved under a guest session: a conversation or a settings row. A guest's files
 * hang off its conversations (`guests/<sessionId>/conversations/<id>/`, or the conversation's own
 * files table), so a session with no conversation has no file either.
 */
async function guestSessionOwnsData(sessionId: string): Promise<boolean> {
	const [conversation, settings] = await Promise.all([
		collections.conversations.findOne({ sessionId }),
		collections.settings.findOne({ sessionId }),
	]);
	return Boolean(conversation || settings);
}

/**
 * Whether another guest session may take this cookie value's place: no `sessions` row (that
 * would be a signed-in session) and no conversation. A guest's files hang off its conversations, so no
 * conversation means no file either. A settings row alone does not count, because dismissing the
 * welcome modal writes one and should not cost a guest the chats they are bringing over. Replacing
 * such a session does lose its settings (that modal flag, a chosen model, answer preferences) for the
 * visitor; the conversations they bring over are worth more than those. (CUR-4445)
 */
export async function isReplaceableGuestSession(token: string): Promise<boolean> {
	const sessionId = await sha256(token);
	const [session, conversation] = await Promise.all([
		collections.sessions.findOne({ sessionId }),
		collections.conversations.findOne({ sessionId }),
	]);
	return !session && !conversation;
}

async function findUser(
	sessionId: string,
	coupledCookieHash: string | undefined,
	url: URL
): Promise<{
	user: User | null;
	invalidateSession: boolean;
	/** No `sessions` row: an anonymous guest, identified by the cookie value alone. */
	guest?: true;
	oauth?: Session["oauth"];
}> {
	const session = await collections.sessions.findOne({ sessionId });

	if (!session) {
		return { user: null, invalidateSession: false, guest: true };
	}

	if (coupledCookieHash && session.coupledCookieHash !== coupledCookieHash) {
		return { user: null, invalidateSession: true };
	}

	// Check if OAuth token needs refresh
	if (session.oauth?.token && session.oauth.refreshToken) {
		// If token expires in less than 5 minutes, refresh it
		if (differenceInMinutes(session.oauth.token.expiresAt, new Date()) < 5) {
			const lockKey = `${Semaphores.OAUTH_TOKEN_REFRESH}:${sessionId}`;

			// Acquire lock for token refresh
			const lockId = await acquireLock(lockKey);
			if (lockId) {
				try {
					// Attempt to refresh the token
					const newTokenSet = await refreshOAuthToken(
						{ redirectURI: `${config.PUBLIC_ORIGIN}${HF_LOGIN_CALLBACK_PATH}` },
						session.oauth.refreshToken,
						url
					);

					if (!newTokenSet || !newTokenSet.access_token) {
						// Token refresh failed, invalidate session
						return { user: null, invalidateSession: true };
					}

					// Update session with new token information
					const updatedOAuth = tokenSetToSessionOauth(newTokenSet);

					if (!updatedOAuth) {
						// Token refresh failed, invalidate session
						return { user: null, invalidateSession: true };
					}

					await collections.sessions.updateOne(
						{ sessionId },
						{
							$set: {
								oauth: updatedOAuth,
								updatedAt: new Date(),
							},
						}
					);

					session.oauth = updatedOAuth;
				} catch (err) {
					logger.error(err, "Error during token refresh:");
					void captureServerException(err);
					return { user: null, invalidateSession: true };
				} finally {
					await releaseLock(lockKey, lockId);
				}
			} else if (new Date() > session.oauth.token.expiresAt) {
				// If the token has expired, we need to wait for the token refresh to complete
				let attempts = 0;
				do {
					await new Promise((resolve) => setTimeout(resolve, 200));
					attempts++;
					if (attempts > 20) {
						return { user: null, invalidateSession: true };
					}
				} while (await isDBLocked(lockKey));

				const updatedSession = await collections.sessions.findOne({ sessionId });
				if (!updatedSession || updatedSession.oauth?.token === session.oauth.token) {
					return { user: null, invalidateSession: true };
				}

				session.oauth = updatedSession.oauth;
			}
		}
	} else if (session.oauth?.token && !session.oauth.refreshToken) {
		if (new Date() > session.oauth.token.expiresAt) {
			return { user: null, invalidateSession: true };
		}
	}

	return {
		user: await collections.users.findOne({ _id: session.userId }),
		invalidateSession: false,
		oauth: session.oauth,
	};
}
export const authCondition = (locals: App.Locals) => {
	if (!locals.user && !locals.sessionId) {
		throw new Error("User or sessionId is required");
	}

	return locals.user
		? { userId: locals.user._id }
		: { sessionId: locals.sessionId, userId: { $exists: false } };
};

/**
 * Derive the persisted session oauth shape from a token endpoint response.
 *
 * THE EXPIRY READ IS THE DELICATE PART (CUR-211). v5's `TokenSet` carried `expires_at`, an ABSOLUTE
 * unix timestamp. v6 removed that field outright — the response carries `expires_in`, RELATIVE
 * seconds, with an `expiresIn()` helper that also floors at 0 once elapsed. The two are not
 * interchangeable and the failure mode of confusing them is silent: reading a field v6 never sets
 * yields `undefined`, the ternary below falls through to the two-week default, and every session
 * outlives its access token by up to a fortnight. Worse, `getSessionUser` only refreshes when the
 * recorded expiry is under five minutes away, so a two-week stamp means the refresh path never fires
 * at all and the token is simply used until the provider rejects it.
 *
 * The two-week fallback is still correct for providers that return no expiry — that is a real case,
 * and there is nothing better to do than pick a bound. It must not become the value we land on
 * because we asked v6 for a field it does not have.
 */
export function tokenSetToSessionOauth(tokenSet: OIDCTokens): Session["oauth"] {
	if (!tokenSet.access_token) {
		return undefined;
	}

	const expiresInSeconds = tokenSet.expiresIn();

	return {
		token: {
			value: tokenSet.access_token,
			expiresAt:
				expiresInSeconds !== undefined
					? subMinutes(new Date(Date.now() + expiresInSeconds * 1000), 1)
					: addWeeks(new Date(), 2),
		},
		refreshToken: tokenSet.refresh_token || undefined,
	};
}

// CACHE THE DISCOVERY DOCUMENT, NOT THE CLIENT. This mirrors v5, where `Issuer.discover()` (a network
// fetch) was cached for ten minutes and `new issuer.Client(...)` (pure construction) ran per call.
//
// v6 folds both into `Configuration`, which invites caching the whole thing — and that would be a
// latency bug, because the client half genuinely varies per call. A redirect URI built from the
// REQUEST origin would differ from the one the token refresh in `findUser` builds from
// `config.PUBLIC_ORIGIN`. On any deployment where those differ — a preview
// hostname, www vs apex — a single-slot Configuration cache would miss on every alternation between a
// login and a refresh, putting a round-trip to the identity provider on the session hot path. Caching
// the ServerMetadata keeps the fetch amortised no matter how the redirect URI moves.
let lastServerMetadata: ServerMetadata | null = null;
let lastServerMetadataFetchedAt: Date | null = null;

export async function getOIDCClient(settings: OIDCSettings, url: URL): Promise<Configuration> {
	// Fail loud, not raw. `discovery()` below does `new URL(OIDConfig.PROVIDER_URL)` — on an unconfigured
	// deployment (no OPENID_* vars, the local-dev default) that's `new URL("")`, which throws a bare
	// TypeError with no SvelteKit error() wrapper. Uncaught, that reaches handleError/+error.svelte as a
	// generic "An error occurred" 500 with a correlation UUID and no indication sign-in just isn't set up
	// here. All three callers of getOIDCClient go through this same OIDC-configured precondition.
	if (!OIDConfig.PROVIDER_URL || !OIDConfig.CLIENT_ID) {
		error(503, "Sign-in is not configured in this environment.");
	}

	let clientId = OIDConfig.CLIENT_ID;

	if (clientId === "__CIMD__") {
		// See https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
		clientId = new URL(
			CIMD_PATH,
			config.PUBLIC_ORIGIN || url.origin
		).toString();
	}

	const metadata: Partial<ClientMetadata> = {
		redirect_uris: [settings.redirectURI],
		response_types: ["code"],
		id_token_signed_response_alg: OIDConfig.ID_TOKEN_SIGNED_RESPONSE_ALG || undefined,
	};

	if (OIDConfig.TOLERANCE) {
		// v5 spelled this `[custom.clock_tolerance]`; v6 moved the symbol onto the client metadata.
		// Seconds, and only applied when configured — the default is v6's own, not zero.
		metadata[clockTolerance] = Number(OIDConfig.TOLERANCE);
	}

	// A missing secret means a PUBLIC client, not a fatal error.
	//
	// Upstream builds `new issuer.Client(client_config)` on openid-client v5, where `client_secret` is
	// an ordinary property — omit it and you get a public client, which is exactly what a CIMD client
	// IS. Our v6 migration (CUR-211) replaced that with an unconditional `ClientSecretPost(...)`, and
	// v6 throws `"clientSecret" must not be empty` on an empty string. That quietly removed the only
	// account path that needs no OAuth app registered: `OPENID_CLIENT_ID=__CIMD__` self-describes via
	// /.well-known/oauth-cimd and has no secret to give.
	const clientAuth = OIDConfig.CLIENT_SECRET ? ClientSecretPost(OIDConfig.CLIENT_SECRET) : None();

	if (
		lastServerMetadata &&
		lastServerMetadataFetchedAt &&
		differenceInMinutes(new Date(), lastServerMetadataFetchedAt) >= 10
	) {
		lastServerMetadata = null;
		lastServerMetadataFetchedAt = null;
	}

	if (!lastServerMetadata) {
		// The only network call in here. `discovery()` fetches and parses the provider's metadata; we
		// keep the parsed result and throw the Configuration it came wrapped in away.
		const discovered = await discovery(
			new URL(OIDConfig.PROVIDER_URL),
			clientId,
			metadata,
			clientAuth
		);
		lastServerMetadata = discovered.serverMetadata();
		lastServerMetadataFetchedAt = new Date();
	}

	// v5 read `id_token_signing_alg_values_supported` off the issuer and pinned the first entry when we
	// had no explicit preference. Kept: some providers advertise an algorithm they will not actually
	// negotiate unless the client names it.
	if (!OIDConfig.ID_TOKEN_SIGNED_RESPONSE_ALG) {
		const algSupported = lastServerMetadata.id_token_signing_alg_values_supported;
		if (Array.isArray(algSupported) && algSupported.length > 0) {
			metadata.id_token_signed_response_alg = algSupported[0];
		}
	}

	return new Configuration(lastServerMetadata, clientId, metadata, clientAuth);
}

/**
 * Refreshes an OAuth token using the refresh token
 */
export async function refreshOAuthToken(
	settings: OIDCSettings,
	refreshToken: string,
	url: URL
): Promise<OIDCTokens | null> {
	const client = await getOIDCClient(settings, url);
	return await refreshTokenGrant(client, refreshToken);
}

type CookieRecord = Cookies;
type HeaderRecord = Headers;

async function getCoupledCookieHash(cookie: CookieRecord): Promise<string | undefined> {
	if (!config.COUPLE_SESSION_WITH_COOKIE_NAME) {
		return undefined;
	}

	const cookieValue = cookie.get(config.COUPLE_SESSION_WITH_COOKIE_NAME);

	if (!cookieValue) {
		return "no-cookie";
	}

	return await sha256(cookieValue);
}

// The shadow `users`/`conversations` doc-store rows are keyed by this hash, NOT by Better
// Auth's own user.id — a query joining workspace membership (member.userId, Better Auth's raw id)
// against conversations (conversations.userId, this hash) has to convert first, or it silently
// matches nothing. Exported here rather than left inline below so there is exactly one place this
// derivation lives — a workspace-usage query importing its own copy is exactly how the two would
// drift if this ever changed. (CUR-552)
export async function shadowUserId(betterAuthUserId: string): Promise<string> {
	return (await sha256(betterAuthUserId)).slice(0, 24);
}

/** The `guest_file_move_skipped` fault, read on the request that signs a guest in. (CUR-3292) */
async function guestFileMoveSkipped(headers: HeaderRecord): Promise<boolean> {
	return (await resolveFaultInjection(new Request("http://fault.local/", { headers }))) === "guest_file_move_skipped";
}

export async function authenticateRequest(
	headers: HeaderRecord,
	cookie: CookieRecord,
	url: URL,
	isApi?: boolean
): Promise<App.Locals & { secretSessionId: string; mintedSession?: boolean }> {
	// The conversation-sync routes take a sync access token and nothing else, and a sync
	// access token is read on these routes and nowhere else. Ahead of the Better Auth bridge on purpose:
	// a browser session cookie riding along on a sync request must not stand in for the token. (CUR-4312)
	if (chatRoutePath(url.pathname).startsWith(`${CHAT_API_PATH}/v2/sync/`)) {
		return authenticateSyncRequest(headers);
	}

	// Better Auth bridge (CUR-434) — checked FIRST, ahead of every branch below. On a hit, the shadow
	// `users` doc-store row (keyed by a deterministic hash of Better Auth's own user.id, which isn't
	// guaranteed to be ObjectId-shaped) is looked up or created on first login, and this returns in the
	// exact shape every other branch already returns — so authCondition, requireAuth/requireAdmin, and
	// every conversations/settings/admin read downstream are unaffected by which system signed someone
	// in. Falls through to the branches below (trusted-header, HF-cookie, bearer-token, anonymous) when
	// there's no Better Auth session, so retiring the old HF flow later is a subtraction, not a rewrite.
	//
	// Deliberately NOT unified with the bearer-token API path below: that path resolves identity from a
	// raw HF token via whoami-v2 for programmatic/API access, a different thing from a browser session.
	// A person who signs in via Better Auth's Hugging Face provider and separately calls the API with a
	// raw HF token gets two distinct identities today — unifying them means reading the linked account's
	// access token out of Better Auth's own `account` table, which is separate work.
	const betterAuthSession = await getAuth()
		.api.getSession({ headers })
		.catch((err) => {
			logger.warn({ err }, "[auth] Better Auth getSession failed — falling through to legacy auth");
			return null;
		});

	// Diagnostic: getSession() resolving cleanly to null is otherwise invisible — the .catch() above
	// only fires on a THROW, never on a "no session found" resolution. Logged unconditionally so a
	// failing request's line can be compared directly against the preceding succeeding one.
	{
		const rawCookie = (() => {
			try {
				return headers.get("cookie") ?? "";
			} catch {
				return "";
			}
		})();
		const hfChatMatch = /(?:^|;\s*)hf-chat=([^;]+)/.exec(rawCookie);
		logger.info(
			{
				url: url.pathname,
				found: !!betterAuthSession,
				cookieHeaderLen: rawCookie.length,
				hasHfChatCookie: !!hfChatMatch,
				hfChatValueLen: hfChatMatch ? hfChatMatch[1].length : 0,
			},
			"[auth][CUR-1172] betterAuthSession resolution"
		);
	}

	if (betterAuthSession) {
		const { user: baUser, session: baSession } = betterAuthSession;
		const shadowId = new ObjectId(await shadowUserId(baUser.id));

		let user = await collections.users.findOne({ _id: shadowId });
		if (!user) {
			// On first login only — an anonymous visitor's conversations/settings otherwise
			// stay tagged to a sessionId this bridge never mints again, invisible forever once
			// authCondition switches to querying by userId. The anonymous cookie is still the one this
			// same request carries (Better Auth's own session cookie is separate, see sessionCookieName's
			// definition above), so this is the one place that old value is still reachable — it must not
			// be deferred to a later request, since refreshSessionCookie overwrites this same cookie name
			// with the Better Auth token further down in handle.ts for any POST/login request. (CUR-849)
			const previousToken = cookie.get(sessionCookieName);
			const previousSessionId = previousToken ? await sha256(previousToken) : undefined;

			// Migrate BEFORE the shadow user row is inserted (CUR-1558). The `findOne` above is
			// the only thing gating a concurrent request's own `!user` check — the instant `insertOne`
			// below commits, every OTHER in-flight request for this browser sees a signed-in user whose
			// conversations authCondition queries strictly by userId, whether or not migration has landed
			// yet. A page load racing that gap gets a 403 on its own just-signed-in conversation and falls
			// back to the generic landing route (resolveConversation.ts's CUR-1315 log names it;
			// chat/conversation/[id]/+page.ts's catch-all is what redirects there). This is a real ordering
			// race, not a theoretical one. All three migrations
			// are idempotent (migrateAnonymousSession.ts, migrateAgentTrust.ts), so running them here is
			// safe even for a request that goes on to lose the insert race below.
			//
			// Settings and conversations now carry a foreign key to `users`, and re-keying them
			// before the row exists fails. The insert and both migrations share one transaction instead,
			// which keeps what this comment asks for: no other request sees the `users` row until the
			// migrated rows commit with it.
			// (CUR-769)
			// Same "first login only" scoping as the two migrations below — a returning user's
			// agent trust already lives under their own subject, so this only matters the one time a
			// session switches from anonymous to signed-in. Best-effort; never blocks sign-in. It is an
			// HTTP call to the agent service, so it runs before the transaction rather than holding it. (CUR-761)
			await migrateAgentTrust(previousSessionId, shadowId);

			const newUser: User = {
				_id: shadowId,
				name: baUser.name || baUser.email,
				email: baUser.email,
				avatarUrl: baUser.image ?? undefined,
				hfUserId: undefined,
				betterAuthUserId: baUser.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			try {
				await withTransaction(async () => {
					// The row goes in first: Postgres checks each foreign key per statement.
					await collections.users.insertOne(newUser);
					await migrateAnonymousSettings(previousSessionId, shadowId);
					await migrateAnonymousConversations(previousSessionId, shadowId, { skipFileMove: await guestFileMoveSkipped(headers) });
				});
				user = newUser;
			} catch (err) {
				// Lost a race with a concurrent request handling this same first login — same
				// insert-then-reread pattern this file already uses for lock acquisition on a
				// unique-key conflict. Our transaction rolled back whole; the winner's committed the same
				// migration with its insert, so its row is already fully migrated and safe to adopt as-is.
				user = await collections.users.findOne({ _id: shadowId });
				if (!user) {
					throw new Error("[auth][CUR-1558] shadow user insert failed with no winner to adopt", { cause: err });
				}
			}
		} else {
			// A RETURNING user, not the first-login case above. The shadow user row already
			// exists, so there's no CUR-1558 insert race to protect — that race was specifically about
			// the gap between this file's own `findOne` and `insertOne` for a row that doesn't exist yet.
			// Without this, a user who signs out, goes anonymous in the same browser, has a conversation,
			// then signs back in gets nothing migrated: the `if (!user)` branch above never runs again,
			// so the new anonymous-session conversation is silently orphaned.
			//
			// migrateAnonymousSettings's own docstring warns that calling it for a returning user
			// "would stomp them" — an existing user has real settings a browser's anonymous prefs
			// shouldn't overwrite. migrateAgentTrust's docstring gives the same warning for a different
			// reason: a returning user's agent trust already lives under their own subject. Neither runs
			// here. migrateAnonymousConversations carries no such warning — its docstring calls this
			// exact case "safe," because the query is keyed strictly by `sessionId` and can only touch
			// the previous anonymous session's own rows, never anything the shadow user already owns. (CUR-1719)
			const previousToken = cookie.get(sessionCookieName);
			const previousSessionId = previousToken ? await sha256(previousToken) : undefined;
			await migrateAnonymousConversations(previousSessionId, shadowId, { skipFileMove: await guestFileMoveSkipped(headers) });

			// The shadow row's name is copied once, at first login, and the account menu reads
			// it from here. A name changed since (Settings → Account calls Better Auth's updateUser) has
			// to reach the row, or the menu keeps the old one for good. (CUR-1176)
			if (baUser.name && baUser.name !== user.name) {
				await collections.users.updateOne({ _id: shadowId }, { $set: { name: baUser.name, updatedAt: new Date() } });
				user = { ...user, name: baUser.name };
			}
			// The same for the email, which a returning OAuth sign-in can now change
			// (refreshProviderEmail.ts). (CUR-3249)
			if (baUser.email && baUser.email !== user.email) {
				await collections.users.updateOne({ _id: shadowId }, { $set: { email: baUser.email, updatedAt: new Date() } });
				user = { ...user, email: baUser.email };
			}
		}

		const sessionId = await sha256(baSession.token);

		return {
			// The verification bit rides along from the session, not the shadow row, which
			// copied the address once at first login and nothing else about it. (CUR-3182)
			user: { ...user, emailVerified: baUser.emailVerified === true, role: baUser.role ?? undefined },
			// See the comment above: intentionally not the HF token even when the provider IS Hugging
			// Face — locals.token's few consumers (endpointOai.ts, apiToken.ts, billing-orgs) already
			// treat it as optional and degrade gracefully, the same posture a guest session already gets.
			token: undefined,
			sessionId,
			secretSessionId: baSession.token,
			isAdmin: !!user.isAdmin,
		};
	}

	const token = cookie.get(sessionCookieName);

	let secretSessionId: string | null = null;
	let sessionId: string | null = null;

	if (token) {
		secretSessionId = token;
		sessionId = await sha256(token);

		const result = await findUser(sessionId, await getCoupledCookieHash(cookie), url);

		// This branch mints too — the caller HAS a cookie, it is just no longer valid — so it
		// has to hand back the replacement on whatever method the request used, exactly like the
		// cookie-less path below. Missing it here would leave an invalidated visitor re-minting on
		// every GET, which is the same defect one branch over. (CUR-1645)
		let mintedSession = false;
		if (result.invalidateSession || (result.guest && !(await keepGuestCookie(token, sessionId)))) {
			({ sessionId, secretSessionId } = await mintAnonymousSession());
			mintedSession = true;
		}

		return {
			user: result.user ?? undefined,
			token: result.oauth?.token?.value,
			sessionId,
			secretSessionId,
			mintedSession,
			isAdmin: !!result.user?.isAdmin,
		};
	}

	// The cron endpoints carry `Authorization: Bearer ${CRON_SECRET}` (Vercel sends it to EVERY cron
	// invocation), which is NOT an HF token — let them through instead of trying (and failing → 500)
	// to resolve it as an API bearer here. Cleanup then runs its own CRON_SECRET gate; warm is
	// deliberately unauthenticated (204-only, fire-and-forget, server-throttled).
	const cronPath = chatRoutePath(url.pathname);
	const cronBearerExempt =
		cronPath === `${CHAT_API_PATH}/cleanup` || cronPath === `${CHAT_API_PATH}/warm`;
	if (isApi && !cronBearerExempt) {
		const authorization = headers.get("Authorization");
		if (authorization?.startsWith("Bearer ")) {
			const token = authorization.slice(7);
			// A sync token reaches this legacy path only off the sync routes, where it is not a
			// credential. Refuse it here, before the Hugging Face lookup below would send it to a third party. (CUR-4315)
			if (token.startsWith(SYNC_ACCESS_TOKEN_PREFIX) || token.startsWith(SYNC_REFRESH_TOKEN_PREFIX)) {
				throw new Error("Unauthorized");
			}
			const hash = await sha256(token);
			sessionId = secretSessionId = hash;

			// Honor the 5-minute cache TTL by query (Postgres has no TTL index; rows are GC'd separately).
			const cacheHit = await collections.tokenCaches.findOne({
				tokenHash: hash,
				createdAt: { $gt: new Date(Date.now() - 5 * 60 * 1000) },
			});
			if (cacheHit) {
				const user = await collections.users.findOne({ hfUserId: cacheHit.userId });
				if (!user) {
					throw new Error("User not found");
				}
				return {
					user,
					sessionId,
					token,
					secretSessionId,
					isAdmin: !!user.isAdmin,
				};
			}

			// Bound the token-verify call so a slow/unreachable HF can't hang the auth path (and the
			// serverless instance) indefinitely. A timeout can't verify the token, so map it to
			// Unauthorized rather than stalling the request until the platform kills the invocation.
			let response: Response;
			try {
				response = await fetch("https://huggingface.co/api/whoami-v2", {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(10000),
				});
			} catch (err) {
				logger.warn({ err }, "[auth] whoami-v2 fetch failed/timed out — treating as unauthorized");
				// `cause` so a downstream handler can tell a timeout from a refusal; the log line does not travel
				// with the error.
				throw new Error("Unauthorized", { cause: err });
			}

			if (!response.ok) {
				throw new Error("Unauthorized");
			}

			const data = await response.json();
			const user = await collections.users.findOne({ hfUserId: data.id });
			if (!user) {
				throw new Error("User not found");
			}

			await collections.tokenCaches.insertOne({
				tokenHash: hash,
				userId: data.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			return {
				user,
				sessionId,
				secretSessionId,
				token,
				isAdmin: !!user.isAdmin,
			};
		}
	}

	// Generate a new session if none exists. Not coalesced against any other cookie-less request — see
	// mintAnonymousSession above for why. The `mintedSession` flag is what tells hooks/handle.ts to hand
	// this cookie back on ANY method (CUR-1645).
	({ sessionId, secretSessionId } = await mintAnonymousSession());

	return { user: undefined, sessionId, secretSessionId, isAdmin: false, mintedSession: true };
}

/**
 * Identity for /chat/api/v2/sync/*, from the `Authorization: Bearer` sync token alone. Never
 * mints a guest session and never sets a cookie (handle.ts skips the refresh when `sync` is set). A
 * request without a usable token comes back with no user and `sync.error`, which the route answers 401
 * or 403. (CUR-4312)
 */
async function authenticateSyncRequest(
	headers: HeaderRecord
): Promise<App.Locals & { secretSessionId: string; mintedSession?: boolean }> {
	const authorization = headers.get("Authorization") ?? "";
	const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const sessionId = await sha256(token ? `sync:${token}` : `sync:${crypto.randomUUID()}`);
	const refused = (error: "unauthenticated" | "not_permitted") => ({
		user: undefined,
		sessionId,
		secretSessionId: sessionId,
		isAdmin: false,
		sync: { error },
	});
	if (!token) return refused("unauthenticated");
	const verified = await verifySyncAccessToken(token).catch((err) => {
		logger.warn({ err }, "[auth][sync] token check failed");
		return { ok: false as const, reason: "unauthenticated" as const };
	});
	if (!verified.ok) return refused(verified.reason);
	const user = await collections.users.findOne({ _id: new ObjectId(await shadowUserId(verified.betterAuthUserId)) });
	// The shadow row exists once the person has opened Alpha signed in, which consent requires.
	if (!user) return refused("unauthenticated");
	// The verification bit comes from the Better Auth row, as on the session path (CUR-3182): the
	// shadow row never stores it, and without it a team-only flag such as thunderbolt-sync evaluates
	// with no email and answers off, so a sync route 404s on any instance that hasn't cached this
	// account's flags from a browser request.
	return {
		user: { ...user, emailVerified: verified.emailVerified },
		sessionId,
		secretSessionId: sessionId,
		isAdmin: false,
		sync: { clientId: verified.clientId },
	};
}
