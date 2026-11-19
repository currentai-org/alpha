// Enrolling and unlocking the conversation-history key from this browser (stage 2).
//
// Every key operation is stage 1's (`historyIdentity.ts`): generate, wrap, unlock, add or remove a way
// in, and the device-key store. This file only decides which of them to call and keeps the server's copy
// current through `GET/PUT /chat/api/v2/keys/history`, whose rewrap is compare-and-set on the hash GET
// returned (`replaces`). A 409 means another browser rewrapped first: read again, apply the same change
// to what it wrote, and try once more.
//
// The server keeps every wrap it was given as a generation, because it cannot tell a real
// rewrap from an age file to nobody that a stolen session uploaded. Unlocking tries the newest wrap
// first, then each older generation, newest first, and the unlocked state says which one opened.

import { identityToRecipient } from 'age-encryption';
import { base } from '$lib/chat/paths';
import {
	addWrapRecipient,
	forgetDeviceKey,
	generateDeviceKey,
	generateHistoryIdentity,
	loadDeviceKey,
	removeWrapRecipient,
	storeDeviceKey,
	unlockHistoryIdentity,
	wrapHistoryIdentity,
	type UnlockedHistoryKey,
	type Unlocker,
	type WrapRecipient
} from './historyIdentity';

/** An older wrap generation the server keeps, as GET lists it. */
type HistoryKeyGenerationRef = { id: string; hash: string; at: number };

/** The wrapped key as the server keeps it. `hash` is what a rewrap names in `replaces`. `generations`
 *  lists the older wraps, newest first; absent means none. */
export type StoredHistoryKey = {
	wrapped: Uint8Array;
	recipient: string;
	hash: string;
	generations?: readonly HistoryKeyGenerationRef[];
};

/** What the key route says about an account's existing chats on the PUT that first stored its key:
 *  sealed to the new key, or left as they were (sealing off here, or it failed). */
export type ExistingChats = 'sealed' | 'not_sealed';
type StoreResult = { existingChats?: ExistingChats };

/** The key route, as an interface so a test can stand in for the server. */
export type HistoryKeyApi = {
	get(): Promise<StoredHistoryKey | null>;
	/** One older generation by the id `get` listed, or null when the server has no such generation. */
	generation(id: string): Promise<{ wrapped: Uint8Array; recipient: string; hash: string } | null>;
	put(body: { wrapped: Uint8Array; recipient: string; replaces?: string }): Promise<StoreResult | void>;
};

/** Which wrap generation an unlock opened: the newest, or an older one because the newer would not. */
type OpenedGeneration = { hash: string; id: string | null; newest: boolean };

type ServiceErrorCode =
	/** The deployment cannot keep a history key (503), or the request failed outright. */
	| 'unavailable'
	/** Another browser rewrapped first (409), twice in a row. */
	| 'conflict'
	/** The server refused the key for another reason (400, 401, 410). */
	| 'refused'
	/** The way in chosen could not be kept: another browser enrolled first, and this one cannot open it. */
	| 'not_kept';

/** Thrown with a `code`; callers branch on `code`, as with `historyIdentity.ts`'s errors. */
class HistoryKeyServiceError extends Error {
	override name = 'HistoryKeyServiceError';
	constructor(
		readonly code: ServiceErrorCode,
		message: string,
		readonly status?: number
	) {
		super(message);
	}
}

const toBase64 = (bytes: Uint8Array) => {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function serviceError(status: number, what: string): HistoryKeyServiceError {
	if (status === 409) return new HistoryKeyServiceError('conflict', `${what}: changed elsewhere`, status);
	if (status === 503 || status >= 500)
		return new HistoryKeyServiceError('unavailable', `${what}: the key store is unavailable`, status);
	return new HistoryKeyServiceError('refused', `${what}: refused (${status})`, status);
}

/** The real key route. */
export function historyKeyApi(fetchFn: typeof fetch = fetch): HistoryKeyApi {
	const url = `${base}/api/v2/keys/history`;
	return {
		async get() {
			const res = await fetchFn(url, { cache: 'no-store' });
			if (res.status === 404) return null;
			if (!res.ok) throw serviceError(res.status, 'reading the history key');
			const body = (await res.json()) as {
				wrapped: string;
				recipient: string;
				hash: string;
				generations?: HistoryKeyGenerationRef[];
			};
			return {
				wrapped: fromBase64(body.wrapped),
				recipient: body.recipient,
				hash: body.hash,
				generations: body.generations ?? []
			};
		},
		async generation(id) {
			const res = await fetchFn(`${url}?generation=${encodeURIComponent(id)}`, { cache: 'no-store' });
			if (res.status === 404) return null;
			if (!res.ok) throw serviceError(res.status, 'reading an older history key');
			const body = (await res.json()) as { wrapped: string; recipient: string; hash: string };
			return { wrapped: fromBase64(body.wrapped), recipient: body.recipient, hash: body.hash };
		},
		async put({ wrapped, recipient, replaces }) {
			const res = await fetchFn(url, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				// format 2: the wrap carries the identity's own stanza (wrapHistoryIdentity), which the
				// server requires of every wrap it stores.
				body: JSON.stringify({ wrapped: toBase64(wrapped), recipient, replaces, format: 2 })
			});
			if (!res.ok) throw serviceError(res.status, 'storing the history key');
			const body = (await res.json().catch(() => null)) as StoreResult | null;
			return { existingChats: body?.existingChats };
		}
	};
}

/** Where this browser keeps its device key for one owner (`historyIdentity.ts` storeDeviceKey). A
 *  guest's session id is not visible to the page, so a browser holds one guest key at a time. */
export function historyKeyOwner(userId: string | null | undefined): string {
	return userId ? `user:${userId}` : 'guest';
}

export type HistoryKeyState =
	/** No key on the server yet: the person has not enrolled. */
	| { kind: 'none' }
	/** This browser's device key opened it. `stored` is always the newest wrap, the one a rewrap replaces;
	 *  `opened` says which generation the identity came from. */
	| {
			kind: 'unlocked';
			stored: StoredHistoryKey;
			unlocked: UnlockedHistoryKey;
			deviceRecipient: string;
			opened: OpenedGeneration;
			/** Set only by the enrollment that stored the key: what became of the chats already there. */
			existingChats?: ExistingChats;
	  }
	/** A key exists, and this browser has no device key that opens it. */
	| { kind: 'locked'; stored: StoredHistoryKey };

// A new device key is kept in a pending slot until the PUT that adds it to the wrap has succeeded, and
// only then moved into the owner's slot. Writing it straight into the owner's slot would overwrite a
// device key that already opens the server's wrap whenever the PUT then lost a race to another tab
// (a 409), leaving a device-only key with no way in at all.
const pendingSlot = (owner: string) => `${owner}#pending`;

async function holdPending(owner: string, key: CryptoKey): Promise<void> {
	await storeDeviceKey(pendingSlot(owner), key);
}

/** The PUT carrying `key` succeeded: it becomes this browser's device key for the owner. */
async function promotePending(owner: string, key: CryptoKey): Promise<void> {
	await storeDeviceKey(owner, key);
	await forgetDeviceKey(pendingSlot(owner));
}

/** The PUT carrying `key` failed: drop it, unless another tab has since put its own key there. */
async function dropPending(owner: string, key: CryptoKey): Promise<void> {
	const held = await loadDeviceKey(pendingSlot(owner));
	// IndexedDB hands back a clone, so compare the keys by their recipients.
	if (held && (await identityToRecipient(held)) === (await identityToRecipient(key))) {
		await forgetDeviceKey(pendingSlot(owner));
	}
}

const NEWEST = (stored: StoredHistoryKey): OpenedGeneration => ({ hash: stored.hash, id: null, newest: true });

/** The failures an older generation may answer: the wrap does not list this way in, will not parse, or
 *  opens to an identity the server does not seal to. Anything else (a cancelled passkey ceremony) is
 *  the person's or the browser's, and is thrown as it is. */
const FALLS_BACK = new Set(['not_for_this_unlocker', 'malformed', 'recipient_mismatch']);

/**
 * Open the owner's key with one way in: the newest wrap first, then each older generation the server
 * keeps, newest first, so a junk wrap a stolen session uploaded never locks the person out.
 * An older generation is only accepted when it opens to the recipient the server seals to, and when no
 * newer generation this way in failed on is one the person made: every wrap the browser makes also
 * opens with the history identity itself (`wrapHistoryIdentity`), so a newer wrap that opens with it to
 * the same identity was written by a holder, and this way in was taken out of it on purpose.
 *
 * @throws the newest wrap's own error when no generation opens, or when this way in was removed.
 */
async function openNewestThatOpens(
	api: HistoryKeyApi,
	stored: StoredHistoryKey,
	unlocker: Unlocker
): Promise<{ unlocked: UnlockedHistoryKey; opened: OpenedGeneration }> {
	let first: unknown;
	try {
		return { unlocked: await unlockHistoryIdentity(stored.wrapped, unlocker, stored.recipient), opened: NEWEST(stored) };
	} catch (e) {
		if (!FALLS_BACK.has((e as { code?: string }).code ?? '')) throw e;
		first = e;
	}
	const failedNewer: Uint8Array[] = [stored.wrapped];
	for (const ref of stored.generations ?? []) {
		const older = await api.generation(ref.id);
		if (!older) continue;
		let unlocked: UnlockedHistoryKey;
		try {
			unlocked = await unlockHistoryIdentity(older.wrapped, unlocker, stored.recipient);
		} catch (e) {
			if (!FALLS_BACK.has((e as { code?: string }).code ?? '')) throw e;
			failedNewer.push(older.wrapped);
			continue;
		}
		for (const newer of failedNewer) {
			if (await madeByAHolder(newer, unlocked.identity, stored.recipient)) throw first;
		}
		return { unlocked, opened: { hash: older.hash, id: ref.id, newest: false } };
	}
	throw first;
}

/** Does `wrapped` open with the history identity to that same identity? Only a holder can write one. */
async function madeByAHolder(wrapped: Uint8Array, identity: string, recipient: string): Promise<boolean> {
	try {
		await unlockHistoryIdentity(wrapped, { kind: 'recovery', recoveryKey: identity }, recipient);
		return true;
	} catch {
		return false;
	}
}

/** Open `stored` with one device key, or null when no generation lists it. */
async function openWithDevice(
	api: HistoryKeyApi,
	stored: StoredHistoryKey,
	key: CryptoKey
): Promise<{ unlocked: UnlockedHistoryKey; opened: OpenedGeneration } | null> {
	try {
		return await openNewestThatOpens(api, stored, { kind: 'device', key });
	} catch (e) {
		// The device key was removed from the wrap elsewhere, or its PUT never landed.
		if ((e as { code?: string }).code === 'not_for_this_unlocker') return null;
		throw e;
	}
}

/** Where this browser stands with the owner's history key. A wrap the device key opens to the wrong
 *  identity (`recipient_mismatch`) or to something unreadable, with no older generation that opens, is
 *  thrown, never treated as locked. A pending key that opens the wrap (its PUT landed, the page closed
 *  before it was promoted) is promoted. `opened` reports an older generation when the newest would not
 *  open; nothing rewraps on its own. A device key taken out of a wrap a person made reads locked. */
export async function readHistoryKeyState(api: HistoryKeyApi, owner: string): Promise<HistoryKeyState> {
	const stored = await api.get();
	if (!stored) return { kind: 'none' };
	for (const slot of [owner, pendingSlot(owner)]) {
		const key = await loadDeviceKey(slot);
		if (!key) continue;
		const result = await openWithDevice(api, stored, key);
		if (!result) continue;
		if (slot !== owner) await promotePending(owner, key);
		return { kind: 'unlocked', stored, ...result, deviceRecipient: await identityToRecipient(key) };
	}
	return { kind: 'locked', stored };
}

/** The way in chosen when encryption is turned on, besides this browser's device key, which every
 *  choice gets. An account must choose a recovery key or a passkey (Settings). */
export type EnrollChoice =
	| { kind: 'recovery'; recipient: string; label: string }
	| { kind: 'passkey'; credential: string; label: string }
	/** The device key alone: a guest's silent key only, never offered to an account. */
	| { kind: 'device-only' };

/**
 * Make the owner's history key and keep it: a fresh identity wrapped to a new device key for this
 * browser and to the way in chosen. The device key waits in the pending slot until the PUT lands, so a
 * lost race never overwrites the key that opens what the server kept. A 409 means another browser or
 * tab enrolled first; the caller reads the state again and unlocks instead.
 */
export async function enrollHistoryKey(
	api: HistoryKeyApi,
	owner: string,
	choice: EnrollChoice,
	deviceLabel: string
): Promise<Extract<HistoryKeyState, { kind: 'unlocked' }>> {
	const { identity, recipient } = await generateHistoryIdentity();
	const device = await generateDeviceKey();
	const recipients: WrapRecipient[] = [{ kind: 'device', label: deviceLabel, recipient: device.recipient }];
	if (choice.kind === 'recovery') recipients.push(choice);
	if (choice.kind === 'passkey') recipients.push(choice);
	const wrapped = await wrapHistoryIdentity(identity, recipients);
	await holdPending(owner, device.key);
	let put: StoreResult | void;
	try {
		put = await api.put({ wrapped, recipient });
	} catch (e) {
		await dropPending(owner, device.key);
		throw e;
	}
	await promotePending(owner, device.key);
	const stored = await api.get();
	if (!stored) throw new HistoryKeyServiceError('unavailable', 'the history key did not read back after storing');
	return {
		kind: 'unlocked',
		stored,
		unlocked: { identity, recipient, recipients },
		deviceRecipient: device.recipient,
		opened: NEWEST(stored),
		existingChats: put ? put.existingChats : undefined
	};
}

/**
 * The way in chosen when turning encryption on, kept even when another tab or browser enrolled the account first. On a
 * 409, the key that won is read again: where this browser opens it (another tab here wrote it, with this
 * browser's device key), the way in the person just chose is added to it, so a recovery key they saved
 * is never one that opens nothing. Where this browser cannot open it, `not_kept` is thrown, and the
 * caller says so and offers the unlock prompt.
 */
export async function enrollOrJoinHistoryKey(
	api: HistoryKeyApi,
	owner: string,
	choice: EnrollChoice,
	deviceLabel: string
): Promise<Extract<HistoryKeyState, { kind: 'unlocked' }>> {
	try {
		return await enrollHistoryKey(api, owner, choice, deviceLabel);
	} catch (e) {
		if ((e as { code?: string }).code !== 'conflict') throw e;
	}
	const state = await readHistoryKeyState(api, owner);
	if (state.kind !== 'unlocked') {
		throw new HistoryKeyServiceError(
			'not_kept',
			'another browser enrolled first and this browser cannot open its key'
		);
	}
	if (choice.kind === 'device-only') return state;
	return addWayIn(api, owner, state, choice);
}

let guestEnrollment: Promise<void> | null = null;

/** A guest's device key, made silently once per page load when the guest has no key on the server. */
export function ensureGuestHistoryKey(api: HistoryKeyApi, deviceLabel: string): Promise<void> {
	guestEnrollment ??= (async () => {
		const state = await readHistoryKeyState(api, historyKeyOwner(null));
		if (state.kind !== 'none') return;
		await enrollHistoryKey(api, historyKeyOwner(null), { kind: 'device-only' }, deviceLabel);
	})().catch((e) => {
		guestEnrollment = null;
		throw e;
	});
	return guestEnrollment;
}

type Rewrap = (unlocked: UnlockedHistoryKey) => Promise<{ wrapped: Uint8Array; recipients: WrapRecipient[] }>;

/** Rewrap from `stored` and PUT it as its replacement. On a 409, `reopen` opens what the other browser
 *  wrote and the same change is applied to it, once. */
async function rewrapAndStore(
	api: HistoryKeyApi,
	stored: StoredHistoryKey,
	unlocked: UnlockedHistoryKey,
	change: Rewrap,
	reopen: (fresh: StoredHistoryKey) => Promise<UnlockedHistoryKey>
): Promise<{ stored: StoredHistoryKey; unlocked: UnlockedHistoryKey; opened: OpenedGeneration }> {
	for (let attempt = 0; ; attempt++) {
		const { wrapped, recipients } = await change(unlocked);
		try {
			await api.put({ wrapped, recipient: stored.recipient, replaces: stored.hash });
		} catch (e) {
			if ((e as { code?: string }).code !== 'conflict' || attempt > 0) throw e;
			const fresh = await api.get();
			if (!fresh) throw new HistoryKeyServiceError('refused', 'the history key disappeared while it was changed');
			stored = fresh;
			unlocked = await reopen(fresh);
			continue;
		}
		const fresh = await api.get();
		if (!fresh) throw new HistoryKeyServiceError('unavailable', 'the history key did not read back after storing');
		return { stored: fresh, unlocked: { ...unlocked, recipients }, opened: NEWEST(fresh) };
	}
}

/**
 * Open a locked key with a recovery key or a passkey, then wrap it again with a new device key for this
 * browser added, so the next visit opens without asking. When only an older generation opens, the
 * rewrap replaces the newest wrap with one made from it, which repairs a junk newest wrap.
 */
export async function unlockAndAddThisBrowser(
	api: HistoryKeyApi,
	owner: string,
	stored: StoredHistoryKey,
	unlocker: Exclude<Unlocker, { kind: 'device' }>,
	deviceLabel: string
): Promise<Extract<HistoryKeyState, { kind: 'unlocked' }>> {
	const { unlocked, opened } = await openNewestThatOpens(api, stored, unlocker);
	const device = await generateDeviceKey();
	await holdPending(owner, device.key);
	const added: WrapRecipient = { kind: 'device', label: deviceLabel, recipient: device.recipient };
	let result: Awaited<ReturnType<typeof rewrapAndStore>>;
	try {
		result = await rewrapAndStore(
			api,
			stored,
			unlocked,
			(u) => addWrapRecipient(u, added),
			async (fresh) => (await openNewestThatOpens(api, fresh, unlocker)).unlocked
		);
	} catch (e) {
		await dropPending(owner, device.key);
		throw e;
	}
	await promotePending(owner, device.key);
	// `opened` is the generation the way in opened, even though the newest wrap is now the rewrap.
	return { kind: 'unlocked', ...result, opened, deviceRecipient: device.recipient };
}

/** Reopen with this browser's device key, for a retry after another browser's rewrap. */
function reopenWithDevice(api: HistoryKeyApi, owner: string) {
	return async (fresh: StoredHistoryKey) => {
		const key = await loadDeviceKey(owner);
		if (!key) throw new HistoryKeyServiceError('refused', "this browser's device key is gone");
		return (await openNewestThatOpens(api, fresh, { kind: 'device', key })).unlocked;
	};
}

/** Add a recovery key or a passkey to an unlocked key (Settings → Your key). */
export async function addWayIn(
	api: HistoryKeyApi,
	owner: string,
	state: Extract<HistoryKeyState, { kind: 'unlocked' }>,
	added: Extract<WrapRecipient, { kind: 'recovery' | 'passkey' }>
): Promise<Extract<HistoryKeyState, { kind: 'unlocked' }>> {
	const result = await rewrapAndStore(
		api,
		state.stored,
		state.unlocked,
		(u) => addWrapRecipient(u, added),
		reopenWithDevice(api, owner)
	);
	return { ...state, ...result };
}

/** Remove one way in. `removeWrapRecipient` refuses the last one (`last_recipient`). */
export async function removeWayIn(
	api: HistoryKeyApi,
	owner: string,
	state: Extract<HistoryKeyState, { kind: 'unlocked' }>,
	removed: WrapRecipient
): Promise<Extract<HistoryKeyState, { kind: 'unlocked' }>> {
	const result = await rewrapAndStore(
		api,
		state.stored,
		state.unlocked,
		(u) => removeWrapRecipient(u, removed),
		reopenWithDevice(api, owner)
	);
	return { ...state, ...result };
}

/** Is this the way in that this browser's device key is? */
export function isThisBrowser(r: WrapRecipient, deviceRecipient: string): boolean {
	return r.kind === 'device' && r.recipient === deviceRecipient;
}

/**
 * Forget this browser: take its device key off the wrap, then delete it here. Refused while it is the
 * only way in, since forgetting it would lock the history for good.
 */
export async function forgetThisBrowser(
	api: HistoryKeyApi,
	owner: string,
	state: Extract<HistoryKeyState, { kind: 'unlocked' }>
): Promise<void> {
	const mine = state.unlocked.recipients.find((r) => isThisBrowser(r, state.deviceRecipient));
	if (mine) await removeWayIn(api, owner, state, mine);
	await forgetDeviceKey(owner);
	await forgetDeviceKey(pendingSlot(owner));
}

/** A recovery key typed back matches the one shown, ignoring case and spaces a person might add. */
export function recoveryKeyMatches(shown: string, typed: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
	return norm(typed) !== '' && norm(typed) === norm(shown);
}

/**
 * Can this browser make a passkey that carries the history key? Asks the browser whether it supports
 * WebAuthn's PRF extension, without a ceremony. typage's `createCredential` still checks the passkey it
 * makes and throws where the authenticator has no PRF, so this only decides whether to offer it.
 */
export async function passkeyPrfOffered(): Promise<boolean> {
	if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') return false;
	const pkc = window.PublicKeyCredential as unknown as {
		getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
	};
	if (typeof pkc.getClientCapabilities !== 'function') return false;
	try {
		const caps = await pkc.getClientCapabilities();
		return caps['extension:prf'] === true;
	} catch {
		return false;
	}
}
