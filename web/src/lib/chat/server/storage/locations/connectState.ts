// What the connect route hands the callback across the trip to Hugging Face. The state, the
// PKCE verifier and the account that started it are sealed into one httpOnly cookie, so the callback
// refuses a code that came back to a different account or with a state it did not mint. (CUR-2932)
import { open, seal, SealedSecretError } from "./sealedSecret";
import { sameState } from "./hfOAuth";
import { CHAT_API_PATH } from "$lib/chat/paths";

export const CONNECT_COOKIE = "hf_storage_connect";
/**
 * The connect cookie's path. Hugging Face returns to the callback at its `/chat/api` path on every
 * surface (the registered redirect URI, `storageOAuthApp`), while the connect route answers at `/api`
 * on the chat surface, so the path is built from `CHAT_API_PATH`, never from `base`: a cookie set at
 * `/api/...` never rides to `/chat/api/.../callback`.
 */
export const CONNECT_COOKIE_PATH = `${CHAT_API_PATH}/storage/locations/hf`;
/** Long enough to read a consent screen, short enough that a stale tab cannot finish a connect. */
export const CONNECT_TTL_SECONDS = 600;

type ConnectState = { state: string; verifier: string; accountId: string; bucket?: string; expiresAt: number };

export function sealConnectState(
	input: { state: string; verifier: string; accountId: string; bucket?: string },
	secret: string,
	now = Date.now()
): string {
	return seal(JSON.stringify({ ...input, expiresAt: now + CONNECT_TTL_SECONDS * 1000 }), secret);
}

/** Why a callback was refused, for the log and for the message the settings page shows. */
export type ConnectRefusal = "missing" | "tampered" | "expired" | "other-account" | "state-mismatch";

/**
 * The PKCE verifier to finish this connect with, or the reason the callback must refuse it. Every
 * check is here so the route cannot skip one.
 */
export function checkConnectState(
	cookie: string | undefined,
	returnedState: string | null,
	accountId: string,
	secret: string,
	now = Date.now()
): { ok: true; verifier: string; bucket?: string } | { ok: false; reason: ConnectRefusal } {
	if (!cookie || !returnedState) return { ok: false, reason: "missing" };
	let parsed: ConnectState;
	try {
		parsed = JSON.parse(open(cookie, secret)) as ConnectState;
	} catch (e) {
		if (e instanceof SealedSecretError || e instanceof SyntaxError) return { ok: false, reason: "tampered" };
		throw e;
	}
	if (parsed.expiresAt <= now) return { ok: false, reason: "expired" };
	if (parsed.accountId !== accountId) return { ok: false, reason: "other-account" };
	if (!sameState(parsed.state, returnedState)) return { ok: false, reason: "state-mismatch" };
	return { ok: true, verifier: parsed.verifier, ...(parsed.bucket ? { bucket: parsed.bucket } : {}) };
}
