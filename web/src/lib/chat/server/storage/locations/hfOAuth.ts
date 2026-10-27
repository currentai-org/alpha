// CUR-2932 adds "Connect Hugging Face" for storage. The person consents on the storage OAuth app, which
// is a separate app from sign-in and is not Better Auth's link-social (that would make the grant a way
// to sign in). Alpha then creates one private bucket in their account and keeps the grant sealed in
// `storage_locations`.
//
// The scope is `contribute-repos`: "create repositories and access those created by this app". Only a
// live consent shows whether Hugging Face applies it to buckets (CUR-2932's Done when). If it does not,
// the bucket create fails and the callback says so; nothing widens the grant on its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRepo, HubApiError, listFiles } from "@huggingface/hub";
import { config } from "$lib/chat/server/config";
import { CHAT_API_PATH } from "$lib/chat/paths";

const HUB = "https://huggingface.co";
const STORAGE_OAUTH_SCOPES = "openid profile contribute-repos";
/** The bucket Alpha makes in the person's account, as `<username>/<this>`, when they name none. */
export const ALPHA_BUCKET_NAME = "alpha-files";

/**
 * A bucket name a person may give on Connect, by Hugging Face's own repo-name rule (huggingface_hub's
 * `validate_repo_id`): letters, digits, `-`, `_` and `.`, starting and ending with a letter, digit or
 * `_`, with no `--` or `..`, not ending in `.git`, at most 96 characters. A name the Hub would refuse
 * is caught here, where the person can still fix it.
 */
export function bucketNameOk(name: string): boolean {
	return (
		/^[A-Za-z0-9_](?:[\w.-]{0,94}[A-Za-z0-9_])?$/.test(name) &&
		!name.includes("--") &&
		!name.includes("..") &&
		!name.endsWith(".git")
	);
}

/** Hugging Face names are case-insensitive: `walk.notes` and `Walk.Notes` are one bucket. */
export function sameRepo(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
/** Renew this long before the access token's own expiry, so a write never starts on a dying token. */
const REFRESH_MARGIN_MS = 60_000;

/** The sealed credential of a connected location: the access token, its refresh token, and when the
 *  access token stops working (epoch ms). */
export type OAuthGrant = { access: string; refresh: string | null; expiresAt: number };

/** Hugging Face would not issue or renew a token for this grant. The registry turns it into
 *  "needs-reconnect". */
export class OAuthGrantError extends Error {
	name = "OAuthGrantError";
}

type StorageOAuthApp = { clientId: string; clientSecret: string; redirectUri: string };

/**
 * The storage app's client credentials and callback, or null when either credential is missing. For a
 * flagged-on account a missing app is a loud misconfiguration: the route logs it and offers no Connect
 * button. It never falls back to another app.
 */
export function storageOAuthApp(): StorageOAuthApp | null {
	const clientId = config.HF_STORAGE_OAUTH_CLIENT_ID;
	const clientSecret = config.HF_STORAGE_OAUTH_CLIENT_SECRET;
	const origin = config.PUBLIC_ORIGIN;
	if (!clientId || !clientSecret || !origin) return null;
	return {
		clientId,
		clientSecret,
		redirectUri: `${origin.replace(/\/$/, "")}${CHAT_API_PATH}/storage/locations/hf/callback`,
	};
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newState(): string {
	return randomBytes(24).toString("base64url");
}

/** Constant-time compare for the state the callback echoes back. */
export function sameState(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function authorizeUrl(app: StorageOAuthApp, state: string, challenge: string): string {
	const u = new URL(`${HUB}/oauth/authorize`);
	u.searchParams.set("client_id", app.clientId);
	u.searchParams.set("redirect_uri", app.redirectUri);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", STORAGE_OAUTH_SCOPES);
	u.searchParams.set("state", state);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	return u.toString();
}

async function tokenRequest(
	app: StorageOAuthApp,
	form: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<OAuthGrant> {
	const res = await fetchImpl(`${HUB}/oauth/token`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
		},
		body: new URLSearchParams(form),
	});
	const body = (await res.json().catch(() => null)) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error?: string;
	} | null;
	if (!res.ok || !body?.access_token) {
		// 400 or 401 means Hugging Face refused this grant (a used code, a revoked app); anything else is
		// a failure on their side and stays a plain error.
		if (res.status === 400 || res.status === 401) {
			throw new OAuthGrantError(`Hugging Face refused the grant (${body?.error ?? res.status})`);
		}
		throw new Error(`Hugging Face token endpoint answered ${res.status}`);
	}
	return {
		access: body.access_token,
		refresh: body.refresh_token ?? null,
		expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
	};
}

export function exchangeCode(
	app: StorageOAuthApp,
	code: string,
	verifier: string,
	fetchImpl: typeof fetch = fetch
): Promise<OAuthGrant> {
	return tokenRequest(
		app,
		{ grant_type: "authorization_code", code, redirect_uri: app.redirectUri, code_verifier: verifier },
		fetchImpl
	);
}

/** The grant unchanged while its access token has over a minute left, else a renewed one. Throws
 *  OAuthGrantError when there is nothing to renew with or Hugging Face declines. */
export async function freshGrant(grant: OAuthGrant, fetchImpl: typeof fetch = fetch): Promise<OAuthGrant> {
	if (grant.expiresAt - REFRESH_MARGIN_MS > Date.now()) return grant;
	const app = storageOAuthApp();
	if (!app) throw new OAuthGrantError("the storage OAuth app is not configured");
	if (!grant.refresh) throw new OAuthGrantError("no refresh token to renew this grant with");
	const renewed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: grant.refresh }, fetchImpl);
	// Hugging Face may or may not rotate the refresh token; keep the old one when no new one comes back.
	return { ...renewed, refresh: renewed.refresh ?? grant.refresh };
}

/** The Hub username the grant belongs to, from OpenID userinfo. */
export async function grantUsername(grant: OAuthGrant, fetchImpl: typeof fetch = fetch): Promise<string> {
	const res = await fetchImpl(`${HUB}/oauth/userinfo`, { headers: { authorization: `Bearer ${grant.access}` } });
	const body = (await res.json().catch(() => null)) as { preferred_username?: string } | null;
	if (!res.ok || !body?.preferred_username) throw new OAuthGrantError(`userinfo answered ${res.status}`);
	return body.preferred_username;
}

/**
 * Create `buckets/<username>/<name>`, private. An existing bucket of that name that this app made is
 * reused, so a second Connect after an unlink lands on the same files.
 * @returns the bucket's repo designation.
 */
async function ensureAlphaBucket(
	username: string,
	grant: OAuthGrant,
	fetchImpl?: typeof fetch,
	name = ALPHA_BUCKET_NAME
): Promise<{ repo: string; existed: boolean }> {
	const repo = `buckets/${username}/${name}`;
	try {
		await createRepo({ repo, visibility: "private", accessToken: grant.access, fetch: fetchImpl });
		return { repo, existed: false };
	} catch (e) {
		if (!(e instanceof HubApiError && e.statusCode === 409)) throw e;
		return { repo, existed: true };
	}
}

/** Thrown when the grant could not create or open the bucket. This is the answer to whether
 *  `contribute-repos` reaches buckets, so the callback reports it apart from a refused consent. */
export class BucketScopeError extends Error {
	name = "BucketScopeError";
}

/** Thrown when the name is already a bucket in the person's account that this app did not make, so
 *  the grant cannot open it. The callback asks for another name rather than blaming the grant. */
export class BucketTakenError extends Error {
	name = "BucketTakenError";
}

/**
 * Make sure the grant can create, then list, the person's bucket: `alpha-files` unless they named one.
 * The grant reaches only buckets this app created, so a name taken by a bucket they made themselves
 * fails here as BucketTakenError, and a grant that cannot create at all as BucketScopeError.
 * @returns the bucket's repo designation.
 */
export async function provisionAlphaBucket(
	username: string,
	grant: OAuthGrant,
	fetchImpl?: typeof fetch,
	name = ALPHA_BUCKET_NAME
): Promise<string> {
	let bucket: { repo: string; existed: boolean } | undefined;
	try {
		bucket = await ensureAlphaBucket(username, grant, fetchImpl, name);
		const it = listFiles({ repo: bucket.repo, accessToken: grant.access, fetch: fetchImpl })[Symbol.asyncIterator]();
		await it.next();
	} catch (e) {
		if (e instanceof HubApiError && [401, 403, 404].includes(e.statusCode)) {
			if (bucket?.existed) {
				throw new BucketTakenError(`${bucket.repo} exists and the grant cannot open it (${e.statusCode})`, { cause: e });
			}
			throw new BucketScopeError(`the grant could not create or open the bucket (${e.statusCode})`, { cause: e });
		}
		throw e;
	}
	return bucket.repo;
}

/** The plaintext that gets sealed into `storage_locations.credential` for an OAuth location. */
export function serializeGrant(grant: OAuthGrant): string {
	return JSON.stringify({ kind: "oauth", ...grant });
}

/** The grant inside an opened credential, or null when the credential is a pasted token. */
export function parseGrant(plaintext: string): OAuthGrant | null {
	if (!plaintext.startsWith("{")) return null;
	const g = JSON.parse(plaintext) as Partial<OAuthGrant> & { kind?: string };
	if (g.kind !== "oauth" || typeof g.access !== "string" || typeof g.expiresAt !== "number") {
		throw new OAuthGrantError("unrecognised grant");
	}
	return { access: g.access, refresh: typeof g.refresh === "string" ? g.refresh : null, expiresAt: g.expiresAt };
}
