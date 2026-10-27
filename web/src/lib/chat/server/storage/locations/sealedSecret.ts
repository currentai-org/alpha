// A credential a person handed us (a Hugging Face token scoped to their own bucket), kept
// encrypted at rest so a database read alone does not yield it.
//
// AES-256-GCM with a fresh 96-bit nonce per seal. The key is HKDF-SHA-256 over BETTER_AUTH_SECRET
// under an info string of its own, so no new secret has to be provisioned and the derived key is
// useless for anything Better Auth signs. The cost: rotating BETTER_AUTH_SECRET makes every sealed
// credential unopenable, and the location then shows "Reconnect" (registry.ts) rather than failing
// somewhere quieter. Each environment has its own database and its own secret, so a value is only
// ever opened by the environment that sealed it. (CUR-2930)
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "$lib/chat/server/config";

const VERSION = "v1";
const INFO = "aipotluck/storage-location-credential/v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The secret every sealed credential derives its key from: storage locations and a person's own MCP
 *  server tokens (CUR-4016), each under its own info string. */
export function credentialSecret(): string {
	const secret = config.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured, so a linked credential cannot be sealed or opened");
	return secret;
}

/** Thrown when a sealed value cannot be opened: tampered, truncated, or sealed under another secret. */
export class SealedSecretError extends Error {
	name = "SealedSecretError";
}

function deriveKey(secret: string, info: string): Buffer {
	if (!secret) throw new SealedSecretError("no secret to derive a sealing key from");
	return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
}

/** Encrypt `plaintext` under a key derived from `secret`. The result is `v1.<base64url>`. Another use
 *  passes its own `info`, which derives a different key, so neither can open the other's values. */
export function seal(plaintext: string, secret: string, info = INFO): string {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, info), nonce, { authTagLength: TAG_BYTES });
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return `${VERSION}.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url")}`;
}

/** Decrypt a value `seal` produced. Throws SealedSecretError on any mismatch, never returns garbage. */
export function open(sealed: string, secret: string, info = INFO): string {
	const [version, payload, ...rest] = sealed.split(".");
	if (version !== VERSION || !payload || rest.length > 0) throw new SealedSecretError("unrecognised sealed value");
	const raw = Buffer.from(payload, "base64url");
	if (raw.length < NONCE_BYTES + TAG_BYTES) throw new SealedSecretError("sealed value is truncated");
	const nonce = raw.subarray(0, NONCE_BYTES);
	const tag = raw.subarray(raw.length - TAG_BYTES);
	const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
	try {
		const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, info), nonce, { authTagLength: TAG_BYTES });
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch (e) {
		throw new SealedSecretError("sealed value failed authentication", { cause: e });
	}
}
