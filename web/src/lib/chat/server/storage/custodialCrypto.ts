// The one place a custodial object is opened, and the keys writes seal to (CUR-4115).
// Design: docs/plans/custodial-file-encryption.md ("The seam", "Key hierarchy").
//
// A sealed object is an age v1 file (`age-encryption`, audited noble underneath) encrypted to its
// owner's hybrid recipient. The owner's identity is itself an age file in the same bucket, at
// `_keys/<user|guest>/<id>.age`, encrypted to a master this deployment holds: an age identity, or an
// AWS KMS key (CUR-4136). Nothing here defines bytes of its own apart from the tombstone marker and
// the KMS key object's three text lines, neither of which is cryptographic.
//
// Anything that does not start with age's magic line is legacy plaintext and passes through
// unchanged, because objects written before sealing are plaintext. So does an age file whose owner
// has no key object: nothing of theirs was ever sealed, so it is a file they uploaded. Refusing plaintext is a later
// deployment switch (design step 4), set only on the new sealed-only EU buckets.
//
// The owner comes from a `Grant`, never from the object's path: a path-check bypass (CUR-3180) then
// hands this module another person's ciphertext with the wrong identity, and age refuses
// it as "no identity matched" instead of decrypting it cleanly.
//
// An unwrapped owner identity lives for one `open` call and is never cached in module scope, so a
// warm function cannot keep a wiped person's key.

import { createHash } from "node:crypto";
import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";
import { config } from "$lib/chat/server/config";
import { logger, securityLogger } from "$lib/chat/server/logger";
import type { StorageRoot } from "./custodialBucket";
import { kmsDecrypt, kmsEncrypt, kmsRegion } from "./custodialKms";

const AGE_MAGIC = new TextEncoder().encode("age-encryption.org/v1\n");

/** What a wipe writes over an owner's key object and their recipient file (CUR-4117), the recipient
 *  first, since writes read only that. A write refuses an owner whose recipient reads as this, and key
 *  creation refuses one whose key object does, so a turn landing after a wipe cannot mint a fresh key. */
export const KEY_TOMBSTONE = "alpha-custodial-key-tombstone\n";

declare const grantBrand: unique symbol;
/** Whose files may be opened. Minted only from an authenticated identity: the session's own user or
 *  guest session, or the owner a conversation-access check returned. Never from a bucket key. */
export type Grant = { readonly root: StorageRoot; readonly id: string; readonly [grantBrand]: true };

/** The one way to make a Grant. Call it with an id that came from the session or an access check. */
export function ownerGrant(root: StorageRoot, id: string): Grant {
	return { root, id } as Grant;
}

/** Reads one object from the bucket the sealed files live in; null when it does not exist.
 *  `uploadedAt` gives the bucket's own upload time for an object, in ms, or null when it is not there;
 *  without it, an age file that will not open can never be told to be one a person stored before
 *  their key existed. */
export type KeyStore = {
	read(path: string): Promise<Uint8Array | null>;
	uploadedAt?(path: string): Promise<number | null>;
};

/** A KeyStore that can also write, for key creation. */
export type KeyBucket = KeyStore & { write(path: string, bytes: Uint8Array): Promise<void> };

/** Runs `fn` while no other instance runs it for the same name: two first writes for one owner must
 *  not mint two keys, or files sealed to the one that lost would never open. */
export type OwnerLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** A KeyStore that reads each key object once for as long as the caller keeps it, meant for one chat
 *  turn: a turn that opens several of one owner's attachments then makes one bucket read for the key,
 *  not one per file. It holds the key object still encrypted to the master, so dropping it at the end
 *  of the turn is the whole lifetime; never keep one in module scope, or a wipe's tombstone goes unseen. */
export function memoKeyStore(inner: KeyStore): KeyStore {
	const seen = new Map<string, Promise<Uint8Array | null>>();
	return {
		read(path) {
			let read = seen.get(path);
			if (!read) {
				read = inner.read(path);
				seen.set(path, read);
				// A failed read is not remembered, so the next file in the turn tries again.
				read.catch(() => seen.delete(path));
			}
			return read;
		},
		uploadedAt: inner.uploadedAt?.bind(inner),
	};
}

export type CustodialCryptoErrorCode =
	/** It starts with age's magic line and its header does not parse. */
	| "not_age"
	/** No identity we hold opens it: another owner's file, or a key object for an unknown master. */
	| "no_identity_matched"
	/** The owner has no key object, so nothing of theirs was ever sealed here. */
	| "key_missing"
	/** The owner's key was destroyed by a wipe. Expected after an account delete. */
	| "key_tombstoned"
	/** This deployment holds no master identity, so no sealed object can be opened. */
	| "master_missing"
	/** The master's holder refused or could not be reached: a KMS access denial, throttle or failure. */
	| "master_unavailable"
	/** The header or a payload chunk failed authentication: tampering, truncation or corruption. */
	| "decrypt_failed";

export class CustodialCryptoError extends Error {
	override name = "CustodialCryptoError";
	constructor(
		readonly code: CustodialCryptoErrorCode,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
	}
	/** Every failure except a tombstone means something is wrong with keys or bytes, and pages. */
	get unexpected(): boolean {
		return this.code !== "key_tombstoned";
	}
}

/** The age path of an owner's key object, beside their files in the same bucket. */
export function ownerKeyPath(grant: Pick<Grant, "root" | "id">): string {
	return `_keys/${grant.root === "users" ? "user" : "guest"}/${grant.id}.age`;
}

/** The owner's public age recipient, in plain text beside their key object. Writes read only this,
 *  so sealing a file never needs the master. It is written once, when the key is made, and never
 *  rewritten by a master rotation, so its upload time is when the owner's sealing began. */
export function ownerRecipientPath(grant: Pick<Grant, "root" | "id">): string {
	return `_keys/${grant.root === "users" ? "user" : "guest"}/${grant.id}.recipient`;
}

/** Whether these bytes are an age file, by its magic line. */
function isSealed(head: Uint8Array): boolean {
	if (head.length < AGE_MAGIC.length) return false;
	for (let i = 0; i < AGE_MAGIC.length; i++) if (head[i] !== AGE_MAGIC[i]) return false;
	return true;
}

/** The masters this deployment holds, by kid, and which one new key objects go to. Two backends share
 *  one kid namespace, and call sites never touch either directly (CUR-4136):
 *  - `CUSTODIAL_MASTER_IDENTITIES`, JSON `{"<kid>": "AGE-SECRET-KEY-PQ-1..."}`: age identities in env,
 *    for previews and a single-host install.
 *  - `CUSTODIAL_MASTER_KMS_KEYS`, JSON `{"<kid>": "arn:aws:kms:..."}`: AWS KMS keys, so the hosted site
 *    holds no key that opens files, only a role that may ask KMS to.
 *  Older epochs stay listed for two releases so a rollback can still read (design, "Master-key epochs"). */
type MasterSet = { identities: Map<string, string>; kmsKeys: Map<string, string>; active: string | null };

function kidMap(name: "CUSTODIAL_MASTER_IDENTITIES" | "CUSTODIAL_MASTER_KMS_KEYS", accept: (value: string) => boolean): Map<string, string> {
	const raw = config[name]?.trim();
	const out = new Map<string, string>();
	if (!raw) return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		logger.error(`[custodial-crypto] ${name} is not JSON; holding none of its masters`);
		return out;
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		for (const [kid, value] of Object.entries(parsed)) {
			if (typeof value === "string" && accept(value)) out.set(kid, value);
		}
	}
	return out;
}

function masterSet(): MasterSet {
	const identities = kidMap("CUSTODIAL_MASTER_IDENTITIES", (v) => v.startsWith("AGE-SECRET-KEY-"));
	const kmsKeys = kidMap("CUSTODIAL_MASTER_KMS_KEYS", (v) => kmsRegion(v) !== null);
	const wanted = config.CUSTODIAL_MASTER_ACTIVE?.trim() || null;
	const active = wanted && (identities.has(wanted) || kmsKeys.has(wanted)) ? wanted : null;
	if (wanted && !active) logger.error({ kid: wanted }, "[custodial-crypto] CUSTODIAL_MASTER_ACTIVE names a kid with no master");
	return { identities, kmsKeys, active };
}

/** The kid new key objects are encrypted to, or null when this deployment holds no master. */
export function activeMasterKid(): string | null {
	return masterSet().active;
}

/** A KMS-wrapped key object: this line, the kid, then KMS's ciphertext in base64. KMS's ciphertext
 *  already names its key; the kid is here so the log can say which epoch opened it, as age's does. */
const KMS_KEY_MAGIC = "alpha-custodial-kms-v1\n";

/** Bound into every KMS wrap, so KMS refuses a key object moved onto another owner's path. */
const ownerContext = (grant: Grant) => ({ "alpha-custodial-owner": `${grant.root}:${grant.id}` });

/** An owner's identity, wrapped to the active master. A kid in both maps wraps with KMS. */
async function wrapToMaster(grant: Grant, identity: string, masters: MasterSet & { active: string }): Promise<Uint8Array> {
	const arn = masters.kmsKeys.get(masters.active);
	if (arn) {
		const blob = await kmsEncrypt(arn, new TextEncoder().encode(identity), ownerContext(grant)).catch((e) => {
			throw new CustodialCryptoError("master_unavailable", "KMS could not wrap the owner's new key", { cause: e });
		});
		return new TextEncoder().encode(`${KMS_KEY_MAGIC}${masters.active}\n${Buffer.from(blob).toString("base64")}\n`);
	}
	const toMaster = new Encrypter();
	toMaster.addRecipient(await identityToRecipient(masters.identities.get(masters.active)!));
	return toMaster.encrypt(identity);
}

async function unwrapWithKms(grant: Grant, keyObject: string, masters: MasterSet): Promise<{ identity: string; kid: string }> {
	const [kid, b64] = keyObject.slice(KMS_KEY_MAGIC.length).split("\n");
	if (!kid || !b64) throw new CustodialCryptoError("decrypt_failed", "the owner's KMS key object is malformed");
	const arn = masters.kmsKeys.get(kid);
	if (!arn) throw new CustodialCryptoError("no_identity_matched", "no KMS key this deployment holds wraps the owner's key object");
	let plain: Uint8Array;
	try {
		plain = await kmsDecrypt(arn, Buffer.from(b64, "base64"), ownerContext(grant));
	} catch (e) {
		// KMS gives this one name to a blob from another key, another owner's context, or altered bytes.
		if (e instanceof Error && e.name === "InvalidCiphertextException") {
			throw new CustodialCryptoError("decrypt_failed", "KMS refused the owner's key object", { cause: e });
		}
		throw new CustodialCryptoError("master_unavailable", "KMS could not unwrap the owner's key object", { cause: e });
	}
	const identity = new TextDecoder().decode(plain).trim();
	if (!identity.startsWith("AGE-SECRET-KEY-")) throw new CustodialCryptoError("decrypt_failed", "the owner's KMS key object held no age identity");
	return { identity, kid };
}

const hash16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Map an `age-encryption` throw to one of our codes. Its messages are the only signal it gives. */
function codeFor(e: unknown): CustodialCryptoErrorCode {
	const message = e instanceof Error ? e.message : String(e);
	if (message.includes("no identity matched")) return "no_identity_matched";
	if (/^invalid (version|header$|stanza)/.test(message)) return "not_age";
	return "decrypt_failed";
}

async function decryptWith(identity: string, bytes: Uint8Array): Promise<Uint8Array> {
	const d = new Decrypter();
	d.addIdentity(identity);
	return d.decrypt(bytes);
}

/** A KeyStore read that threw: the bucket's own error, carried out of the seam untouched so the
 *  caller's transient-error retry still sees a 429 or a 503 for what it is. */
class KeyReadFailed {
	constructor(readonly cause: unknown) {}
}

/** The owner's identity, unwrapped with whichever master opens their key object. */
async function unwrapOwner(grant: Grant, keys: KeyStore, masters: MasterSet): Promise<{ identity: string; kid: string }> {
	let keyObject: Uint8Array | null;
	try {
		keyObject = await keys.read(ownerKeyPath(grant));
	} catch (e) {
		throw new KeyReadFailed(e);
	}
	if (!keyObject) throw new CustodialCryptoError("key_missing", "the owner has no key object");
	if (new TextDecoder().decode(keyObject) === KEY_TOMBSTONE) {
		throw new CustodialCryptoError("key_tombstoned", "the owner's key was destroyed");
	}
	if (masters.identities.size + masters.kmsKeys.size === 0) throw new CustodialCryptoError("master_missing", "this deployment holds no master identity");
	const head = new TextDecoder().decode(keyObject.slice(0, KMS_KEY_MAGIC.length));
	if (head === KMS_KEY_MAGIC) return unwrapWithKms(grant, new TextDecoder().decode(keyObject), masters);
	// One master at a time, so the log can say which epoch opened it.
	for (const [kid, master] of masters.identities) {
		try {
			const identity = new TextDecoder().decode(await decryptWith(master, keyObject)).trim();
			return { identity, kid };
		} catch (e) {
			const code = codeFor(e);
			if (code === "no_identity_matched") continue;
			throw new CustodialCryptoError(code, `the owner's key object would not open: ${code}`, { cause: e });
		}
	}
	throw new CustodialCryptoError("no_identity_matched", "no master identity opens the owner's key object");
}

/** Whether the object at `bucketPath` was uploaded before the owner's recipient file. False whenever
 *  either time is unknown, so a doubt pages rather than passing bytes through. */
async function storedBeforeKey(grant: Grant, bucketPath: string, keys: KeyStore): Promise<boolean> {
	if (!keys.uploadedAt) return false;
	try {
		const [file, key] = await Promise.all([keys.uploadedAt(bucketPath), keys.uploadedAt(ownerRecipientPath(grant))]);
		return file !== null && key !== null && file < key;
	} catch {
		return false;
	}
}

/** The owner's public recipient, made with their key on the owner's first sealed write. Never unwraps
 *  a key except to repair a recipient file lost between the two writes of key creation.
 *  @throws CustodialCryptoError key_tombstoned after a wipe, master_missing on a deployment with no master. */
export async function ownerRecipient(grant: Grant, bucket: KeyBucket, lock: OwnerLock): Promise<string> {
	const existing = await readRecipient(grant, bucket);
	if (existing) return existing;
	const started = Date.now();
	const masters = masterSet();
	// Minted before the lock, because the lock's transaction holds a database connection for as long as
	// it runs (CUR-4431). A key that loses the race to another instance is dropped unused.
	const minted = masters.active ? await mintKey(grant, { ...masters, active: masters.active }) : null;
	const lockAsked = Date.now();
	const made = await lock(ownerLockName(grant), async () => {
		// Another instance may have made it while this one waited.
		const recipient = await readRecipient(grant, bucket);
		if (recipient) return { recipient, created: false };
		const keyObject = await bucket.read(ownerKeyPath(grant));
		if (keyObject) {
			if (new TextDecoder().decode(keyObject) === KEY_TOMBSTONE) {
				throw new CustodialCryptoError("key_tombstoned", "the owner's key was destroyed");
			}
			// A key with no recipient file: the earlier creation stopped between its two writes. The one
			// KMS call left under the lock, and only on this repair.
			const owner = await unwrapOwner(grant, bucket, masters).catch((e) => {
				throw e instanceof KeyReadFailed ? e.cause : e;
			});
			const repaired = await identityToRecipient(owner.identity);
			await bucket.write(ownerRecipientPath(grant), new TextEncoder().encode(`${repaired}\n`));
			return { recipient: repaired, created: false };
		}
		if (!minted) throw new CustodialCryptoError("master_missing", "this deployment holds no master identity to wrap a new key to");
		await storeKey(grant, bucket, minted);
		return { recipient: minted.recipient, created: true };
	});
	if (made.created && minted) logKeyCreated(grant, masters.active!, minted, started, lockAsked);
	return made.recipient;
}

/** A fresh owner identity wrapped to the active master, and the wrap opened again, so a key the master
 *  cannot open fails here and not on the person's first read. Holds no lock: these are the remote calls. */
type MintedKey = { keyObject: Uint8Array; recipient: string; mintMs: number; wrapMs: number; checkMs: number };

async function mintKey(grant: Grant, masters: MasterSet & { active: string }): Promise<MintedKey> {
	const t0 = Date.now();
	const identity = await generateHybridIdentity();
	const recipient = await identityToRecipient(identity);
	const t1 = Date.now();
	const keyObject = await wrapToMaster(grant, identity, masters);
	const t2 = Date.now();
	const back = await unwrapOwner(grant, { read: async () => keyObject }, masters).catch(() => null);
	if (back?.identity !== identity) {
		throw new CustodialCryptoError("decrypt_failed", "the new key object did not open with the master it was wrapped to");
	}
	return { keyObject, recipient, mintMs: t1 - t0, wrapMs: t2 - t1, checkMs: Date.now() - t2 };
}

/** Write a minted key, for a caller holding the owner's lock: the key object, read back so a key the
 *  bucket did not keep fails before anything is sealed to it, then the recipient file, which writes read. */
async function storeKey(grant: Grant, bucket: KeyBucket, key: MintedKey): Promise<void> {
	await bucket.write(ownerKeyPath(grant), key.keyObject);
	const back = await bucket.read(ownerKeyPath(grant));
	if (!back || Buffer.compare(Buffer.from(back), Buffer.from(key.keyObject)) !== 0) {
		throw new CustodialCryptoError("decrypt_failed", "the new key object did not read back as written");
	}
	await bucket.write(ownerRecipientPath(grant), new TextEncoder().encode(`${key.recipient}\n`));
}

function logKeyCreated(grant: Grant, kid: string, key: MintedKey, started: number, lockAsked: number): void {
	const now = Date.now();
	logger.info(
		{
			event: "custodial-key-created",
			ownerHash: hash16(`${grant.root}:${grant.id}`),
			kid,
			ms: now - started,
			mintMs: key.mintMs,
			wrapMs: key.wrapMs,
			checkMs: key.checkMs,
			lockedMs: now - lockAsked,
		},
		"[custodial-crypto] owner key created"
	);
}

/** Give an owner whose key was tombstoned a new one (CUR-4415), for a wipe that keeps the account
 *  ("Forget everything"). The tombstone has already destroyed the old key, so nothing sealed under it
 *  opens again; the new identity is unrelated to it. The recipient file is written last: until then it
 *  still reads as the tombstone, so a write cannot start against a key object that is half made. */
export async function replaceOwnerKey(grant: Grant, bucket: KeyBucket, lock: OwnerLock): Promise<void> {
	const started = Date.now();
	const masters = masterSet();
	if (!masters.active) throw new CustodialCryptoError("master_missing", "this deployment holds no master identity to wrap a new key to");
	const minted = await mintKey(grant, { ...masters, active: masters.active });
	const lockAsked = Date.now();
	await lock(ownerLockName(grant), () => storeKey(grant, bucket, minted));
	logKeyCreated(grant, masters.active, minted, started, lockAsked);
}

/** Destroy an owner's key (CUR-4117): the recipient file first, since writes read only that, then the
 *  key object. Written whether or not the owner ever had a key, so a write that starts after this is
 *  refused either way, and under the creation lock, so a key being made right now cannot land on top. */
export async function tombstoneOwnerKey(grant: Grant, bucket: KeyBucket, lock: OwnerLock): Promise<void> {
	const tombstone = new TextEncoder().encode(KEY_TOMBSTONE);
	await lock(ownerLockName(grant), async () => {
		await bucket.write(ownerRecipientPath(grant), tombstone);
		await bucket.write(ownerKeyPath(grant), tombstone);
	});
	logger.info({ event: "custodial-key-tombstoned", ownerHash: hash16(`${grant.root}:${grant.id}`) }, "[custodial-crypto] owner key destroyed");
}

function ownerLockName(grant: Grant): string {
	return `custodial-key:${grant.root}:${grant.id}`;
}

async function readRecipient(grant: Grant, bucket: KeyStore): Promise<string | null> {
	const bytes = await bucket.read(ownerRecipientPath(grant));
	if (!bytes) return null;
	const text = new TextDecoder().decode(bytes);
	if (text === KEY_TOMBSTONE) throw new CustodialCryptoError("key_tombstoned", "the owner's key was destroyed");
	return text.trim();
}

/** Seal bytes to an owner's recipient as one age file, with a fresh file key inside it. */
export async function sealToRecipient(recipient: string, content: Uint8Array): Promise<Uint8Array> {
	const e = new Encrypter();
	e.addRecipient(recipient);
	return e.encrypt(content);
}

function report(grant: Grant, err: CustodialCryptoError, fields: { kid?: string; recipientFp?: string }): void {
	const line = { event: "custodial-open-failed", code: err.code, ownerHash: hash16(`${grant.root}:${grant.id}`), ...fields };
	if (err.unexpected) securityLogger.error(line, "[custodial-crypto] open failed");
	else logger.info(line, "[custodial-crypto] open refused: key tombstoned");
}

/**
 * Open one object read from the custodial bucket, for the owner the grant names.
 *
 * Plaintext (anything without age's magic line) comes back unchanged. A sealed object comes back
 * decrypted, or this throws a CustodialCryptoError. `relPath` is not bound into the file (age has no
 * associated data); it is only used to tell a caller's logs apart.
 */
export async function openCustodialObject(grant: Grant, relPath: string, blob: Blob, keys: KeyStore): Promise<Blob> {
	if (!isSealed(new Uint8Array(await blob.slice(0, AGE_MAGIC.length).arrayBuffer()))) return blob;
	const started = Date.now();
	const masters = masterSet();
	let kid: string | undefined;
	let recipientFp: string | undefined;
	try {
		const owner = await unwrapOwner(grant, keys, masters);
		kid = owner.kid;
		recipientFp = hash16(await identityToRecipient(owner.identity));
		let plain: Uint8Array;
		try {
			plain = await decryptWith(owner.identity, new Uint8Array(await blob.arrayBuffer()));
		} catch (e) {
			// Every write is sealed from the moment the owner's recipient exists, so an object stored
			// before then is one the person uploaded, whatever its first line says (a `backup.age`).
			// Both times are the bucket's own clock; a replaced object gets a new one, so tampering with
			// an old file still pages.
			if (await storedBeforeKey(grant, relPath, keys)) {
				logger.info({ ownerHash: hash16(`${grant.root}:${grant.id}`), relPath }, "[custodial-crypto] age file stored before the owner's key: passed through as plaintext");
				return blob;
			}
			const code = codeFor(e);
			throw new CustodialCryptoError(code, `the object would not open: ${code}`, { cause: e });
		}
		logger.debug({ kid, recipientFp, relPath, ms: Date.now() - started }, "[custodial-crypto] opened");
		return new Blob([plain as BlobPart]);
	} catch (e) {
		if (e instanceof KeyReadFailed) throw e.cause;
		const err = e instanceof CustodialCryptoError ? e : new CustodialCryptoError("decrypt_failed", "open failed", { cause: e });
		// Nothing is sealed for an owner with no key object, so an age file of theirs is one they
		// uploaded (a `backup.age`) and is theirs to download as it is. Once they have a key, storedBeforeKey
		// tells their own age files from sealed ones.
		if (err.code === "key_missing") {
			logger.info({ ownerHash: hash16(`${grant.root}:${grant.id}`), relPath }, "[custodial-crypto] age file with no owner key: passed through as plaintext");
			return blob;
		}
		report(grant, err, { kid, recipientFp });
		throw err;
	}
}

let canaryRun: Promise<void> | null = null;

/**
 * Seal and open a throwaway owner's file through the same unwrap and decrypt as a real read, once per
 * instance. It proves the master identity and the library work on this deployment before any real
 * file depends on them, and writes one line Axiom can be searched for per deploy. Never throws.
 */
export function runCustodialCanary(): Promise<void> {
	canaryRun ??= (async () => {
		const started = Date.now();
		const masters = masterSet();
		if (!masters.active) {
			logger.warn({ event: "custodial-canary", ok: false, reason: "no master" }, "[custodial-crypto] canary skipped: no master identity");
			return;
		}
		try {
			const owner = await generateHybridIdentity();
			const grant = ownerGrant("users", "canary");
			const wrapStarted = Date.now();
			const keyObject = await wrapToMaster(grant, owner, { ...masters, active: masters.active });
			const wrapMs = Date.now() - wrapStarted;
			const toOwner = new Encrypter();
			toOwner.addRecipient(await identityToRecipient(owner));
			const payload = `canary ${started}`;
			const sealed = await toOwner.encrypt(payload);
			const keys: KeyStore = { read: async (p) => (p === ownerKeyPath(grant) ? keyObject : null) };
			const openStarted = Date.now();
			const opened = await (await openCustodialObject(grant, "canary", new Blob([sealed as BlobPart]), keys)).text();
			const openMs = Date.now() - openStarted;
			if (opened !== payload) throw new Error("canary opened to different bytes");
			logger.info(
				{ event: "custodial-canary", ok: true, kid: masters.active, ms: Date.now() - started, wrapMs, openMs },
				"[custodial-crypto] canary ok"
			);
		} catch (e) {
			securityLogger.error(
				{ event: "custodial-canary", ok: false, kid: masters.active, err: e instanceof Error ? e.message : String(e) },
				"[custodial-crypto] canary failed"
			);
		}
	})();
	return canaryRun;
}
