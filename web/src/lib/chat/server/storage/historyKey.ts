// Where an owner's conversation-history key lives in the custodial bucket.
//
// Two objects beside the owner's file key, under the same `_keys/<user|guest>/` prefix:
// - `<id>.history.age`: the history identity wrapped in the browser to the person's devices,
//   passkeys and recovery key. This server cannot open it and never tries.
// - `<id>.history.recipient`: the identity's public age recipient, which is all sealing needs.
//
// The server checks shape only: the wrap is an age file and the recipient is a hybrid age recipient.
// The recipient is written once and never changed, because everything sealed to it would stop opening.
// - `<id>.history.age.<generation id>`: every wrap ever stored, append-only. The server cannot
//   tell a real rewrap from an age file to nobody, so a stolen session could otherwise replace the only
//   wrap the owner's keys open. Older generations stay readable, and the browser falls back through them.
// - `<id>.history.generations`: the list of those generations, oldest first, so a reader finds them
//   without listing the bucket. Nothing prunes a generation yet: pruning waits for a signal that the
//   owner opened a newer one, which only a holder of the identity can give.
// - `<id>.history.age.prev`: the single previous generation an earlier layout kept. Never written or
//   read now; a wipe still overwrites it. It is never made a generation: a wrap from before the browser
//   added its self stanza (`wrapHistoryIdentity`) cannot be told apart from junk, so a way in removed
//   back then must not come back through the wrap before the removal.
//
// A rewrap is compare-and-set: GET returns the current wrap's hash, and a PUT that replaces an existing
// wrap must carry it as `replaces`, checked under the lock, so two browsers rewrapping from the same
// read cannot silently drop the first one's change. Creation and every rewrite hold the file key's own
// lock (`custodial-key:<root>:<id>`), so they serialize with a wipe's tombstone of the file key.
// Either history object reading as the tombstone marker means the owner was wiped, and then neither GET
// nor PUT serves them. Account deletion writes that marker (`tombstoneHistoryKey`), so a deleted
// account's recipient accepts no seal. "Forget everything" keeps the account, so it overwrites the
// objects with the reset marker instead (`resetHistoryKey`): the old wrap is destroyed, and the slot
// reads as empty, so the person can enroll a new key.

import { createHash } from "node:crypto";
import { logger } from "$lib/chat/server/logger";
import { KEY_TOMBSTONE, type Grant, type KeyBucket, type KeyStore, type OwnerLock } from "./custodialCrypto";

const AGE_MAGIC = "age-encryption.org/v1\n";

/** A wrapped history key is a few stanzas and a short JSON payload; one passkey stanza is ~150 bytes. */
export const HISTORY_KEY_MAX_BYTES = 16 * 1024;

/** A hybrid (ML-KEM-768 + X25519) age recipient: `age1pq1` and bech32 characters, nothing else. */
const HYBRID_RECIPIENT = /^age1pq1[02-9ac-hj-np-z]+$/;

export type HistoryKeyStoreErrorCode =
	/** The wrap is not an age file, or is larger than any real one. */
	| "invalid_wrap"
	/** The recipient is not a hybrid age recipient. */
	| "invalid_recipient"
	/** The owner already has a different recipient; replacing it would orphan everything sealed to it. */
	| "recipient_changed"
	/** The owner's history key was destroyed by a wipe. */
	| "key_tombstoned"
	/** A rewrap did not name the wrap it replaces, or named one that is no longer current. */
	| "stale_wrap";

export class HistoryKeyStoreError extends Error {
	override name = "HistoryKeyStoreError";
	constructor(
		readonly code: HistoryKeyStoreErrorCode,
		message: string
	) {
		super(message);
	}
}

const dir = (grant: Pick<Grant, "root" | "id">) => `_keys/${grant.root === "users" ? "user" : "guest"}/${grant.id}`;

/** The wrapped history identity's path. */
function historyKeyPath(grant: Pick<Grant, "root" | "id">): string {
	return `${dir(grant)}.history.age`;
}

/** Where the first version kept the wrap a rewrap replaced: read to migrate it, and overwritten by a wipe. */
function historyPrevPath(grant: Pick<Grant, "root" | "id">): string {
	return `${dir(grant)}.history.age.prev`;
}

/** One stored wrap generation: `id` names its object, `hash` is wrapHash of its bytes, `at` is when it was
 *  stored (ms). */
export type HistoryKeyGeneration = { id: string; hash: string; at: number };

/** A generation id: the store time in ms, zero-padded so ids sort by time, and the hash's first 16 hex. */
const GENERATION_ID = /^[0-9]{15}-[0-9a-f]{16}$/;

function generationPath(grant: Pick<Grant, "root" | "id">, id: string): string {
	return `${dir(grant)}.history.age.${id}`;
}

function generationsPath(grant: Pick<Grant, "root" | "id">): string {
	return `${dir(grant)}.history.generations`;
}

/** The generations list as stored, oldest first: empty when absent or reset, and refused when it is not
 *  one this code wrote, since a list that silently read as empty would hide wraps a wipe must overwrite. */
function parseGenerations(bytes: Uint8Array | null): HistoryKeyGeneration[] {
	if (bytes === null) return [];
	const parsed = JSON.parse(decode(bytes)) as { v?: unknown; generations?: unknown };
	if (parsed?.v !== 1 || !Array.isArray(parsed.generations)) throw new Error("the history key's generations list is not one this code wrote");
	return parsed.generations.filter(
		(g): g is HistoryKeyGeneration =>
			typeof g?.id === "string" && GENERATION_ID.test(g.id) && typeof g.hash === "string" && typeof g.at === "number"
	);
}

const encodeGenerations = (generations: HistoryKeyGeneration[]) => new TextEncoder().encode(JSON.stringify({ v: 1, generations }));

/** The hash a rewrap names in `replaces`: SHA-256 of the stored wrap, hex. */
function wrapHash(wrapped: Uint8Array): string {
	return createHash("sha256").update(wrapped).digest("hex");
}

/** The history identity's public recipient's path. */
function historyRecipientPath(grant: Pick<Grant, "root" | "id">): string {
	return `${dir(grant)}.history.recipient`;
}

/** What "Forget everything" leaves in each history object: the old bytes are gone, and the slot reads as
 *  never enrolled, so a new key may be stored. */
const HISTORY_KEY_RESET = "alpha-history-key-reset\n";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isTombstone = (bytes: Uint8Array | null) => bytes !== null && decode(bytes) === KEY_TOMBSTONE;
/** A history object as stored, with the reset marker read as absent. */
const live = (bytes: Uint8Array | null) => (bytes !== null && decode(bytes) === HISTORY_KEY_RESET ? null : bytes);
const hash16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The owner's wrapped history key and recipient, or null when they have none yet.
 *  @throws HistoryKeyStoreError key_tombstoned after a wipe. */
export async function readHistoryKey(
	grant: Grant,
	keys: KeyStore
): Promise<{ wrapped: Uint8Array; recipient: string; hash: string; generations: HistoryKeyGeneration[] } | null> {
	const [recipient, wrapped, list] = await Promise.all([
		readHistoryRecipient(grant, keys),
		keys.read(historyKeyPath(grant)).then(live),
		readGenerationList(grant, keys),
	]);
	if (isTombstone(wrapped)) throw new HistoryKeyStoreError("key_tombstoned", "the owner's history key was destroyed");
	// Creation writes the wrap first, so a wrap with no recipient is a creation that stopped halfway:
	// nothing was ever sealed to it, and the browser may PUT again.
	if (!recipient || !wrapped) return null;
	const hash = wrapHash(wrapped);
	// Every generation but the one served as current, newest first: the order the browser tries them in.
	const generations = list.filter((g) => g.hash !== hash).reverse();
	return { wrapped, recipient, hash, generations };
}

/** The owner's generations list, oldest first.
 *  @throws HistoryKeyStoreError key_tombstoned when a wipe overwrote it. */
async function readGenerationList(grant: Grant, keys: KeyStore): Promise<HistoryKeyGeneration[]> {
	const list = live(await keys.read(generationsPath(grant)));
	if (isTombstone(list)) throw new HistoryKeyStoreError("key_tombstoned", "the owner's history key was destroyed");
	return parseGenerations(list);
}

/**
 * One older generation of the owner's wrap, by the id `readHistoryKey` listed, or null when the owner has
 * no such generation. The id is looked up in the owner's own list, never turned into a path unchecked.
 *
 * @throws HistoryKeyStoreError key_tombstoned after a wipe.
 */
export async function readHistoryKeyGeneration(
	grant: Grant,
	keys: KeyStore,
	id: string
): Promise<{ wrapped: Uint8Array; recipient: string; hash: string } | null> {
	const [recipient, list] = await Promise.all([readHistoryRecipient(grant, keys), readGenerationList(grant, keys)]);
	if (!recipient) return null;
	const generation = list.find((g) => g.id === id);
	if (!generation) return null;
	const wrapped = live(await keys.read(generationPath(grant, generation.id)));
	if (isTombstone(wrapped)) throw new HistoryKeyStoreError("key_tombstoned", "the owner's history key was destroyed");
	if (!wrapped || wrapHash(wrapped) !== generation.hash) return null;
	return { wrapped, recipient, hash: generation.hash };
}

/** Keep `wrapped` as a generation of its own, unless the list already has one with its hash: written and
 *  read back before the list names it, so the list never names a generation the bucket did not keep. */
async function appendGeneration(
	grant: Grant,
	bucket: KeyBucket,
	generations: HistoryKeyGeneration[],
	wrapped: Uint8Array,
	at: number
): Promise<HistoryKeyGeneration[]> {
	const hash = wrapHash(wrapped);
	if (generations.some((g) => g.hash === hash)) return generations;
	// Two generations stored in the same millisecond still get distinct, ordered ids.
	const last = generations.at(-1)?.at ?? 0;
	const when = Math.max(at, last + 1);
	const generation = { id: `${String(when).padStart(15, "0")}-${hash.slice(0, 16)}`, hash, at: when };
	await bucket.write(generationPath(grant, generation.id), wrapped);
	const back = await bucket.read(generationPath(grant, generation.id));
	if (!back || wrapHash(back) !== hash) throw new Error("a history key generation did not read back as written");
	return [...generations, generation];
}

/**
 * Store the owner's wrapped history key: the first time with its recipient, afterwards a rewrap to the
 * same recipient (a way in added or removed).
 *
 * @returns whether this call created the owner's history key.
 * @param body.replaces - for a rewrap, the hash GET returned for the wrap being replaced.
 * @throws HistoryKeyStoreError for a malformed body, a changed recipient, a stale or missing
 * `replaces` on a rewrap, or a tombstoned owner.
 */
export async function storeHistoryKey(
	grant: Grant,
	bucket: KeyBucket,
	lock: OwnerLock,
	body: { wrapped: Uint8Array; recipient: string; replaces?: string }
): Promise<{ created: boolean }> {
	const { wrapped } = body;
	const recipient = body.recipient.trim();
	if (wrapped.length > HISTORY_KEY_MAX_BYTES || !decode(wrapped.slice(0, AGE_MAGIC.length)).startsWith(AGE_MAGIC)) {
		throw new HistoryKeyStoreError("invalid_wrap", "the wrapped history key is not an age file of a plausible size");
	}
	if (!HYBRID_RECIPIENT.test(recipient)) {
		throw new HistoryKeyStoreError("invalid_recipient", "the history recipient is not a hybrid age recipient");
	}
	const started = Date.now();
	const result = await lock(historyLockName(grant), async () => {
		const existing = live(await bucket.read(historyRecipientPath(grant)));
		const current = live(await bucket.read(historyKeyPath(grant)));
		const list = live(await bucket.read(generationsPath(grant)));
		if (isTombstone(existing) || isTombstone(current) || isTombstone(list)) {
			throw new HistoryKeyStoreError("key_tombstoned", "the owner's history key was destroyed");
		}
		if (existing && decode(existing).trim() !== recipient) {
			throw new HistoryKeyStoreError("recipient_changed", "the owner already has a different history recipient");
		}
		// A wrap with no recipient is a creation that stopped halfway (readHistoryKey), not a rewrap. Its
		// generation stays on the list, so a wipe still finds and overwrites it.
		let generations = parseGenerations(list);
		if (existing && current) {
			if (body.replaces !== wrapHash(current)) {
				throw new HistoryKeyStoreError("stale_wrap", "the rewrap does not name the current wrap it replaces");
			}
			// An owner stored before generations existed: their current wrap becomes the first.
			generations = await appendGeneration(grant, bucket, generations, current, started - 1);
		}
		generations = await appendGeneration(grant, bucket, generations, wrapped, started);
		await bucket.write(generationsPath(grant), encodeGenerations(generations));
		await bucket.write(historyKeyPath(grant), wrapped);
		const back = await bucket.read(historyKeyPath(grant));
		if (!back || Buffer.compare(Buffer.from(back), Buffer.from(wrapped)) !== 0) {
			throw new Error("the wrapped history key did not read back as written");
		}
		// The recipient last, so a server never seals to a key whose wrap the bucket did not keep.
		if (!existing) await bucket.write(historyRecipientPath(grant), new TextEncoder().encode(`${recipient}\n`));
		return { created: !existing };
	});
	logger.info(
		{ event: result.created ? "history-key-created" : "history-key-rewrapped", ownerHash: hash16(`${grant.root}:${grant.id}`), ms: Date.now() - started },
		"[history-key] stored"
	);
	return result;
}

/** The file key's own lock name (custodialCrypto.ts ownerLockName), so a wipe and a history write
 *  for one owner never interleave. */
function historyLockName(grant: Grant): string {
	return `custodial-key:${grant.root}:${grant.id}`;
}

/**
 * The owner's history recipient, which is all sealing needs, or null when they have not enrolled.
 * Read without a lock: the recipient is written last on creation and never changed after, and a wipe
 * overwrites it first.
 *
 * @throws HistoryKeyStoreError key_tombstoned after account deletion, so nothing is sealed to the
 * recipient of an account that no longer exists.
 */
export async function readHistoryRecipient(grant: Grant, keys: KeyStore): Promise<string | null> {
	const bytes = live(await keys.read(historyRecipientPath(grant)));
	if (isTombstone(bytes)) throw new HistoryKeyStoreError("key_tombstoned", "the owner's history key was destroyed");
	return bytes ? decode(bytes).trim() : null;
}

/** Who holds the history identity: the person, in a wrap only their devices open, or the server. */
export type HistoryKeyHolder = "person" | "server";

/** Where the holder marker lives: `<id>.history.holder`, holding `server` for a server-held key. */
function historyHolderPath(grant: Pick<Grant, "root" | "id">): string {
	return `${dir(grant)}.history.holder`;
}

/**
 * Who holds this owner's history key. `person` unless the holder object says `server`: every key stored
 * before the server could hold one is person-held, so an absent, unreadable-as-marker or reset object
 * reads as `person`, the answer that keeps the server's own readers off. A server-held key's creator sets
 * the object to `server\n` (the `historyHolderPath` object); nothing in this module writes it.
 */
export async function readHistoryHolder(grant: Grant, keys: KeyStore): Promise<HistoryKeyHolder> {
	const bytes = live(await keys.read(historyHolderPath(grant)));
	return bytes !== null && decode(bytes).trim() === "server" ? "server" : "person";
}

/**
 * Every owner with a history recipient object, as `users:<id>` or `guests:<id>`, from one listing of
 * the `_keys/` prefixes: for a job that would otherwise read one object per owner, such as the seal
 * backfill. Presence only: an object holding the reset or tombstone marker is listed too, so
 * a caller still reads each listed owner's recipient with `readHistoryRecipient`. An owner not listed
 * has no recipient.
 *
 * @param list - every object path under a prefix, at any depth (a CustodialBackend's `list`).
 */
export async function historyRecipientOwners(list: (prefix: string) => AsyncIterable<{ path: string }>): Promise<Set<string>> {
	const owners = new Set<string>();
	const suffix = historyRecipientPath({ root: "users", id: "" }).slice(dir({ root: "users", id: "" }).length);
	for (const root of ["users", "guests"] as const) {
		const prefix = dir({ root, id: "" });
		for await (const { path } of list(prefix)) {
			if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
			const id = path.slice(prefix.length, path.length - suffix.length);
			// The path an id of this root would have, and no deeper object that happens to share the suffix.
			if (id && historyRecipientPath({ root, id }) === path && !id.includes("/")) owners.add(`${root}:${id}`);
		}
	}
	return owners;
}

/** Overwrite every history object with `marker`, recipient first, since sealing reads only that, and the
 *  generations list last, since it is what names every generation to overwrite. Under the file key's
 *  lock, so a creation or rewrap in flight cannot land on top. A list this code cannot read throws before
 *  anything is written past the recipient, so no generation is left behind unnamed. */
async function overwriteHistoryKey(grant: Grant, bucket: KeyBucket, lock: OwnerLock, marker: string): Promise<void> {
	const bytes = new TextEncoder().encode(marker);
	await lock(historyLockName(grant), async () => {
		await bucket.write(historyRecipientPath(grant), bytes);
		const list = live(await bucket.read(generationsPath(grant)));
		const generations = isTombstone(list) ? [] : parseGenerations(list);
		await bucket.write(historyKeyPath(grant), bytes);
		await bucket.write(historyPrevPath(grant), bytes);
		for (const g of generations) await bucket.write(generationPath(grant, g.id), bytes);
		await bucket.write(generationsPath(grant), bytes);
	});
}

/** Destroy an owner's history key for good (account deletion): GET and PUT answer 410 from now on, and
 *  `readHistoryRecipient` refuses, so no turn seals to the old recipient. Written whether or not the
 *  owner ever enrolled. */
export async function tombstoneHistoryKey(grant: Grant, bucket: KeyBucket, lock: OwnerLock): Promise<void> {
	await overwriteHistoryKey(grant, bucket, lock, KEY_TOMBSTONE);
	logger.info({ event: "history-key-tombstoned", ownerHash: hash16(`${grant.root}:${grant.id}`) }, "[history-key] destroyed");
}

/** Destroy an owner's history key and leave the slot empty ("Forget everything"): the old wrap and every
 *  generation of it are overwritten, and the person may enroll a new key with a new recipient. */
export async function resetHistoryKey(grant: Grant, bucket: KeyBucket, lock: OwnerLock): Promise<void> {
	await overwriteHistoryKey(grant, bucket, lock, HISTORY_KEY_RESET);
	logger.info({ event: "history-key-reset", ownerHash: hash16(`${grant.root}:${grant.id}`) }, "[history-key] reset");
}
