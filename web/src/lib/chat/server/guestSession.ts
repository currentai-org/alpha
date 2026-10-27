// A guest's session cookie must be a value this server issued.
//
// A guest has no `sessions` row: their identity is sha256 of the cookie value, and every per-session
// limit (chat/rateLimit.ts) keys on it. Before this, any made-up value was accepted as a session, and
// a caller could reset their per-session limit by sending a new one. A minted value is
// now `<uuid>.<base64url HMAC-SHA-256(uuid)>`, keyed by HKDF over BETTER_AUTH_SECRET under an info
// string of its own (the pattern sealedSecret.ts uses), so no new secret is provisioned and the key
// signs nothing Better Auth does. Rotating BETTER_AUTH_SECRET re-mints every guest who has no saved
// conversation or setting; one who has keeps their session through the legacy rule in auth.ts.
//
// What this does not stop: a caller who drops the cookie gets a fresh signed one, one request at a
// time. The per-IP ceiling in rateLimit.ts bounds that; the signature only removes the free version. (CUR-3191)
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const INFO = "aipotluck/guest-session/v1";

function deriveKey(secret: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
}

function mac(id: string, secret: string): Buffer {
	return createHmac("sha256", deriveKey(secret)).update(id).digest();
}

/** A new guest cookie value: a random id and its signature. */
export function mintGuestToken(secret: string): string {
	const id = crypto.randomUUID();
	return `${id}.${mac(id, secret).toString("base64url")}`;
}

/** True only for a value `mintGuestToken` produced under this same secret. */
export function isMintedGuestToken(token: string, secret: string): boolean {
	const dot = token.lastIndexOf(".");
	if (dot <= 0 || dot === token.length - 1) return false;
	const id = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), "base64url");
	const expected = mac(id, secret);
	return given.length === expected.length && timingSafeEqual(given, expected);
}
