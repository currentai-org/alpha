// Shared Web-Crypto primitives for the app's stateless HMAC proof cookies (the admin gate in
// adminToken.ts and the RAG-admin gate in rag/ragAuth.ts), built on the global `crypto.subtle` with
// no library. Both auth paths share this one definition so they can't drift. Edge-safe: no
// `node:crypto` / Buffer, so it works in the Vercel serverless runtime.

/** Lowercase hex-encode an ArrayBuffer. */
export const hex = (buf: ArrayBuffer): string =>
	Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** HMAC-SHA-256(key, message) as a lowercase hex digest, via Web Crypto. */
export async function hmacSha256(key: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	return hex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
}

/**
 * Constant-time compare — avoids leaking a proof/digest via timing. Only ever called on equal-length
 * hex digests (callers compare against a freshly computed HMAC of the same width), so the
 * length-mismatch early-out can't leak credential length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Compares a caller-supplied value against a shared secret in time that depends only on the
 * secret's length. Unlike `timingSafeEqual`, a wrong-length guess doesn't return early,
 * so the comparison leaks neither a matching prefix nor the secret's length.
 */
export function secretEquals(given: string | null | undefined, secret: string): boolean {
	const g = given ?? "";
	let diff = g.length ^ secret.length;
	for (let i = 0; i < secret.length; i++) diff |= (g.charCodeAt(i) || 0) ^ secret.charCodeAt(i);
	return diff === 0;
}
