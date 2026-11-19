// The person's conversation-history key, made and opened in the browser (stage 1).
//
// The history identity is an age `mlkem768x25519` hybrid identity. The server keeps two things for it:
// the public recipient, which is all it needs to seal, and the identity wrapped as one age file to
// every way the person can open it. Nothing here defines bytes: the wrap is an ordinary age v1 file
// made by `age-encryption` (typage), and each way in is one of typage's own recipients:
//
// - device:   a non-extractable X25519 WebCrypto key kept in this browser's IndexedDB. typage takes a
//             CryptoKey as an X25519 identity and derives its recipient from it.
// - passkey:  typage's WebAuthn PRF recipient (`age-encryption.org/fido2prf` stanzas).
// - recovery: a second age hybrid identity the person keeps, shown once. It is 256 random bits, so it
//             needs no key derivation; age's scrypt passphrase recipient was not usable because age
//             allows a scrypt stanza only as the sole stanza of a file.
//
// What the wrap opens to is JSON: the identity and the list of recipients it was wrapped to, so a
// browser that has unlocked it can wrap it again with one added or removed. The list lives inside the
// ciphertext, so the server never learns which devices or passkeys a person has.
//
// Re-wrapping asks every passkey that stays on the list for its PRF again: age has no way to add a
// stanza to an existing file, and a PRF recipient has no public half to encrypt to.

import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient, webauthn } from 'age-encryption';

/** One way into the wrapped identity. `label` is the person's own name for it ("This laptop"). */
export type WrapRecipient =
	| { kind: 'device'; label: string; recipient: string }
	| { kind: 'recovery'; label: string; recipient: string }
	/** `credential` is typage's `AGE-PLUGIN-FIDO2PRF-1…` string: the credential id and RP id, no secret. */
	| { kind: 'passkey'; label: string; credential: string };

/** What opens the wrapped identity on this occasion: one of the person's ways in. */
export type Unlocker =
	| { kind: 'device'; key: CryptoKey }
	| { kind: 'recovery'; recoveryKey: string }
	/** Without `credential`, typage asks the browser for any discoverable passkey made on this site, as
	 *  its `Options.identity` documents: a locked browser cannot read which passkeys the wrap lists. */
	| { kind: 'passkey'; credential?: string };

/** The history identity, opened. Hold it in memory only; never write `identity` anywhere. */
export type UnlockedHistoryKey = {
	identity: string;
	recipient: string;
	recipients: WrapRecipient[];
};

type HistoryKeyErrorCode =
	/** The unlocker given is not one the file was wrapped to. */
	| 'not_for_this_unlocker'
	/** It opened, but what it holds is not a history key this code wrote. */
	| 'malformed'
	/** It opened to an identity whose recipient is not the one the server says this owner seals to. */
	| 'recipient_mismatch'
	/** Removing this one would leave no way in. */
	| 'last_recipient'
	/** This browser has no X25519 in WebCrypto, so it cannot hold a device key. */
	| 'device_key_unsupported';

/** Thrown with a `code`; callers branch on `code`, not on the class. */
class HistoryKeyError extends Error {
	override name = 'HistoryKeyError';
	constructor(
		readonly code: HistoryKeyErrorCode,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
	}
}

type Payload = { v: 1; identity: string; recipients: WrapRecipient[] };

/** A fresh history identity and its public recipient. The caller wraps it before anything else. */
export async function generateHistoryIdentity(): Promise<{ identity: string; recipient: string }> {
	const identity = await generateHybridIdentity();
	return { identity, recipient: await identityToRecipient(identity) };
}

/** A recovery key: an age hybrid identity the person keeps, and the recipient that goes in the wrap. */
export async function generateRecoveryKey(): Promise<{ recoveryKey: string; recipient: string }> {
	const { identity, recipient } = await generateHistoryIdentity();
	return { recoveryKey: identity, recipient };
}

/** A device key: a non-extractable X25519 private key, and its age recipient. Store `key` with
 *  `storeDeviceKey`; it cannot be exported, so losing this browser's storage loses this way in. */
export async function generateDeviceKey(): Promise<{ key: CryptoKey; recipient: string }> {
	let pair: CryptoKeyPair;
	try {
		pair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
			'deriveBits'
		])) as CryptoKeyPair;
	} catch (e) {
		throw new HistoryKeyError('device_key_unsupported', 'this browser cannot make an X25519 key', {
			cause: e
		});
	}
	return { key: pair.privateKey, recipient: await identityToRecipient(pair.privateKey) };
}

/** Make a passkey that can carry the history key, through typage. Throws where the authenticator has
 *  no PRF; only a live check tells (design, "Facts this design rests on"). */
export async function createPasskeyCredential(keyName: string, rpId?: string): Promise<string> {
	return webauthn.createCredential({ keyName, rpId });
}

function recipientFor(r: WrapRecipient): string | webauthn.WebAuthnRecipient {
	return r.kind === 'passkey' ? new webauthn.WebAuthnRecipient({ identity: r.credential }) : r.recipient;
}

/**
 * Wrap the history identity to every recipient listed, as one age file. The identity's own recipient
 * gets a stanza too, unlisted: whoever already holds the identity can then open any wrap and see that it
 * carries the same identity, which only a holder could have written. That is how the browser tells a
 * wrap a person made (a way in removed on purpose) from an age file to nobody that a stolen session
 * uploaded (`historyKeyClient.ts`).
 */
export async function wrapHistoryIdentity(
	identity: string,
	recipients: WrapRecipient[]
): Promise<Uint8Array> {
	if (recipients.length === 0) {
		throw new HistoryKeyError('last_recipient', 'a history key wrapped to nobody could never open');
	}
	const e = new Encrypter();
	for (const r of recipients) e.addRecipient(recipientFor(r));
	e.addRecipient(await identityToRecipient(identity));
	const payload: Payload = { v: 1, identity, recipients };
	return e.encrypt(JSON.stringify(payload));
}

/** A recovery key as age reads it: no whitespace anywhere, upper case. A key shown in upper case and typed
 *  back in lower case, or with spaces, opens the same as the shown one. */
function normalizeRecoveryKey(typed: string): string {
	return typed.replace(/\s+/g, '').toUpperCase();
}

function identityFor(u: Unlocker): string | CryptoKey | webauthn.WebAuthnIdentity {
	if (u.kind === 'device') return u.key;
	if (u.kind === 'recovery') return normalizeRecoveryKey(u.recoveryKey);
	return new webauthn.WebAuthnIdentity(u.credential ? { identity: u.credential } : {});
}

function parsePayload(text: string): Payload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new HistoryKeyError('malformed', 'the history key did not hold JSON', { cause: e });
	}
	const p = parsed as Partial<Payload> | null;
	if (
		!p ||
		p.v !== 1 ||
		typeof p.identity !== 'string' ||
		!p.identity.startsWith('AGE-SECRET-KEY-PQ-1') ||
		!Array.isArray(p.recipients)
	) {
		throw new HistoryKeyError('malformed', 'the history key is not one this code wrote');
	}
	return p as Payload;
}

/**
 * Open the wrapped history identity with one way in.
 *
 * @param expectRecipient - the public recipient the server holds for this owner. An identity whose
 * recipient differs is refused, so a wrap swapped on the server is not used to read. Required: there is
 * no unlock that skips the check.
 */
export async function unlockHistoryIdentity(
	wrapped: Uint8Array,
	unlocker: Unlocker,
	expectRecipient: string
): Promise<UnlockedHistoryKey> {
	const d = new Decrypter();
	try {
		d.addIdentity(identityFor(unlocker));
	} catch (e) {
		// A mistyped recovery key fails its checksum here, and the parser's message repeats the typed text,
		// nearly the whole key. Neither that message nor the error that carries it leaves this function.
		if (unlocker.kind === 'recovery') {
			throw new HistoryKeyError('not_for_this_unlocker', 'that is not a valid recovery key');
		}
		throw e;
	}
	let text: string;
	try {
		text = await d.decrypt(wrapped, 'text');
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const cause = unlocker.kind === 'recovery' ? {} : { cause: e };
		if (message.includes('no identity matched')) {
			throw new HistoryKeyError('not_for_this_unlocker', 'this way in does not open the history key', cause);
		}
		throw new HistoryKeyError(
			'malformed',
			unlocker.kind === 'recovery' ? 'the history key would not open' : `the history key would not open: ${message}`,
			cause
		);
	}
	const payload = parsePayload(text);
	const recipient = await identityToRecipient(payload.identity);
	if (expectRecipient !== recipient) {
		throw new HistoryKeyError(
			'recipient_mismatch',
			'the history key opened to an identity the server does not seal to'
		);
	}
	return { identity: payload.identity, recipient, recipients: payload.recipients };
}

function sameWay(a: WrapRecipient, b: WrapRecipient): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'passkey' && b.kind === 'passkey') return a.credential === b.credential;
	return (a as { recipient: string }).recipient === (b as { recipient: string }).recipient;
}

/** Wrap again with one more way in. Adding one already on the list replaces its label. */
export async function addWrapRecipient(
	unlocked: UnlockedHistoryKey,
	added: WrapRecipient
): Promise<{ wrapped: Uint8Array; recipients: WrapRecipient[] }> {
	const recipients = [...unlocked.recipients.filter((r) => !sameWay(r, added)), added];
	return { wrapped: await wrapHistoryIdentity(unlocked.identity, recipients), recipients };
}

/** Wrap again without one way in. The removed way no longer opens the new file; a copy of the old
 *  file, or anything it already decrypted, is beyond reach (design, "Sources"). */
export async function removeWrapRecipient(
	unlocked: UnlockedHistoryKey,
	removed: WrapRecipient
): Promise<{ wrapped: Uint8Array; recipients: WrapRecipient[] }> {
	const recipients = unlocked.recipients.filter((r) => !sameWay(r, removed));
	if (recipients.length === 0) {
		throw new HistoryKeyError('last_recipient', 'removing the only way in would lock the history for good');
	}
	return { wrapped: await wrapHistoryIdentity(unlocked.identity, recipients), recipients };
}

// The device key's home: one IndexedDB store, values are CryptoKeys, which IndexedDB keeps as
// structured clones with `extractable: false` intact.

const DB_NAME = 'alpha-history-keys';
const STORE = 'device-keys';

function openKeyDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function inStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await openKeyDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const request = run(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** Keep this browser's device key for one owner. `owner` is e.g. `user:<id>`; one browser may hold
 *  keys for several accounts. */
export async function storeDeviceKey(owner: string, key: CryptoKey): Promise<void> {
	await inStore('readwrite', (s) => s.put(key, owner));
}

/** This browser's device key for one owner, or null when it has none. */
export async function loadDeviceKey(owner: string): Promise<CryptoKey | null> {
	const key = await inStore('readonly', (s) => s.get(owner) as IDBRequest<CryptoKey | undefined>);
	return key ?? null;
}

/** Forget this browser's device key for one owner, as signing out of a shared computer would. */
export async function forgetDeviceKey(owner: string): Promise<void> {
	await inStore('readwrite', (s) => s.delete(owner));
}
