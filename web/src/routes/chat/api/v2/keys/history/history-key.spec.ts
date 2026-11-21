import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decrypter, Encrypter, generateHybridIdentity, generateX25519Identity, identityToRecipient } from "age-encryption";
import { KEY_TOMBSTONE, ownerGrant } from "$lib/chat/server/storage/custodialCrypto";
import { readHistoryRecipient, resetHistoryKey, tombstoneHistoryKey } from "$lib/chat/server/storage/historyKey";

// GET/PUT /chat/api/v2/keys/history. The contract that matters most: a caller only ever
// reaches their OWN history key, whatever the request says, because the owner comes from the session.
// The bucket is an in-memory map, so a test can see exactly which paths were read and written; the
// lock runs its function in place, since one request at a time needs no database to serialise it.

const store = new Map<string, Uint8Array>();
const reads: string[] = [];
const storage = vi.hoisted(() => ({ configured: vi.fn(() => true), guests: vi.fn(() => false) }));

vi.mock("$lib/chat/server/storage/custodialStorage", () => ({
	custodialStorageConfigured: () => storage.configured(),
	custodialKeyBucket: () => ({
		read: async (p: string) => {
			reads.push(p);
			return store.get(p) ?? null;
		},
		write: async (p: string, bytes: Uint8Array) => void store.set(p, bytes),
	}),
}));
vi.mock("$lib/chat/server/storage/custodialStorageGate", () => ({
	custodialStorageForGuestsEnabled: () => storage.guests(),
}));
const lockNames = vi.hoisted(() => [] as string[]);
vi.mock("$lib/chat/server/db/advisoryLock", () => ({
	withAdvisoryLock: <T>(name: string, fn: () => Promise<T>) => {
		lockNames.push(name);
		return fn();
	},
}));

// The rewrap limit counts rows in message_events; here an in-memory list stands in for the table.
const events = vi.hoisted(() => [] as { key: string; expiresAt: number }[]);
vi.mock("$lib/chat/server/db/eventWindow", () => {
	const keyOf = (k: { type: string; userId?: unknown }) => `${k.type}|${String(k.userId)}`;
	const live = (k: { type: string; userId?: unknown }) => events.filter((e) => e.key === keyOf(k) && e.expiresAt > Date.now());
	return {
		allowanceRoom: async (k: { type: string; userId?: unknown }, max: number) =>
			live(k).length < max ? { ok: true } : { ok: false, retryAfterSecs: Math.ceil((live(k)[0].expiresAt - Date.now()) / 1000) },
		recordEvent: async (k: { type: string; userId?: unknown }, windowMs: number) => void events.push({ key: keyOf(k), expiresAt: Date.now() + windowMs }),
	};
});

// The opt-in seal of an account's existing chats, stood in for so these tests need no database.
const sealing = vi.hoisted(() => ({ on: vi.fn(() => true), sealOwnerHistory: vi.fn(async (_userId: string) => ({ sealed: { conversations: 0, messages: 0 }, changedMeanwhile: 0 })) }));
vi.mock("$lib/chat/server/chat/sealedTurn", () => ({ conversationSealWritesOn: () => sealing.on() }));
vi.mock("$lib/chat/server/chat/sealBackfill", () => ({ sealOwnerHistory: (id: string) => sealing.sealOwnerHistory(id) }));

import { GET, PUT } from "./+server";

// 24 hex, the shape locals.user._id carries. Invented.
const ALICE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "bbbbbbbbbbbbbbbbbbbbbbbb";

const asUser = (id: string) => ({ user: { _id: { toString: () => id } }, sessionId: `session-of-${id}` });
const asGuest = (sessionId: string) => ({ sessionId });

const URL_ = "https://alpha.test/chat/api/v2/keys/history";

async function wrapFor(): Promise<{ wrapped: string; recipient: string }> {
	const identity = await generateHybridIdentity();
	const recipient = await identityToRecipient(identity);
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(await generateHybridIdentity()));
	const wrapped = await e.encrypt(JSON.stringify({ v: 1, identity, recipients: [] }));
	return { wrapped: Buffer.from(wrapped).toString("base64"), recipient };
}

function putRaw(locals: object, body: BodyInit, headers: Record<string, string> = {}) {
	const request = new Request(URL_, { method: "PUT", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit);
	// @ts-expect-error - RequestEvent is heavier than this test needs
	return PUT({ locals, request, url: new URL(URL_) });
}

/** A PUT as today's browser sends it: format 2, unless the body says otherwise. */
const put = (locals: object, body: object) => putRaw(locals, JSON.stringify({ format: 2, ...body }));

function get(locals: object) {
	// @ts-expect-error - RequestEvent is heavier than this test needs
	return GET({ locals, request: new Request(URL_), url: new URL(URL_) });
}

/** What `GET ?generation=<id>` serves this caller. */
async function servedGeneration(locals: object, id: string) {
	const url = new URL(`${URL_}?generation=${encodeURIComponent(id)}`);
	// @ts-expect-error - RequestEvent is heavier than this test needs
	const res = await GET({ locals, request: new Request(url), url });
	return res.json() as Promise<{ wrapped: string; recipient: string; hash: string; id: string }>;
}

/** What GET serves this caller: wrap, recipient and the wrap's hash. */
const served = async (locals: object) => (await get(locals)).json() as Promise<{ wrapped: string; recipient: string; hash: string }>;

beforeEach(() => {
	store.clear();
	events.length = 0;
	reads.length = 0;
	lockNames.length = 0;
	storage.configured.mockReturnValue(true);
	storage.guests.mockReturnValue(false);
	sealing.on.mockReturnValue(true);
	sealing.sealOwnerHistory.mockClear();
	sealing.sealOwnerHistory.mockImplementation(async () => ({ sealed: { conversations: 0, messages: 0 }, changedMeanwhile: 0 }));
});

describe("history key route: one owner never reaches another's key", () => {
	it("returns the caller's own wrap and recipient, byte for byte, after a PUT", async () => {
		const alice = await wrapFor();
		const res = await put(asUser(ALICE), alice);
		expect(res.status).toBe(201);
		expect(await served(asUser(ALICE))).toMatchObject(alice);
	});

	it("answers 404 to Bob while only Alice has a key, reading none of Alice's paths", async () => {
		await put(asUser(ALICE), await wrapFor());
		reads.length = 0;
		await expect(get(asUser(BOB))).rejects.toMatchObject({ status: 404 });
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.filter((p) => p.includes(ALICE))).toEqual([]);
	});

	it("serves two sessions each their own key, and Bob's PUT leaves Alice's exactly as it was", async () => {
		const alice = await wrapFor();
		const bob = await wrapFor();
		await put(asUser(ALICE), alice);
		expect((await put(asUser(BOB), bob)).status).toBe(201);
		expect(await served(asUser(ALICE))).toMatchObject(alice);
		expect(await served(asUser(BOB))).toMatchObject(bob);
	});

	it("keeps a guest whose session id equals an account id apart from that account", async () => {
		storage.guests.mockReturnValue(true);
		await put(asUser(ALICE), await wrapFor());
		await expect(get(asGuest(ALICE))).rejects.toMatchObject({ status: 404 });
	});

	it("refuses an anonymous caller with 401 where guests may not store, and reads nothing", async () => {
		await expect(get(asGuest("some-guest"))).rejects.toMatchObject({ status: 401 });
		expect(reads).toEqual([]);
	});
});

describe("history key route: refusals are loud", () => {
	it("answers 503 and logs, never a silent 200, on a deployment with no custodial storage", async () => {
		storage.configured.mockReturnValue(false);
		const { logger } = await import("$lib/chat/server/logger");
		const logged = vi.spyOn(logger, "error");
		await expect(put(asUser(ALICE), await wrapFor())).rejects.toMatchObject({ status: 503 });
		await expect(get(asUser(ALICE))).rejects.toMatchObject({ status: 503 });
		expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "history-key-no-storage" }), expect.any(String));
		expect(store.size).toBe(0);
	});

	it("refuses with 409 a PUT that would change the owner's recipient, and keeps the first", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		const { hash } = await served(asUser(ALICE));
		await expect(put(asUser(ALICE), { ...(await wrapFor()), replaces: hash })).rejects.toMatchObject({ status: 409 });
		expect(await served(asUser(ALICE))).toMatchObject(first);
	});

	it("accepts a rewrap naming the current wrap's hash with 200, serves it, and lists the old wrap as an older generation", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		const { hash } = await served(asUser(ALICE));
		const rewrap = { ...(await wrapFor()), recipient: first.recipient };
		const res = await put(asUser(ALICE), { ...rewrap, replaces: hash });
		expect(res.status).toBe(200);
		const now = (await served(asUser(ALICE))) as Awaited<ReturnType<typeof served>> & { generations: { id: string; hash: string }[] };
		expect(now).toMatchObject(rewrap);
		expect(now.generations.map((g) => g.hash)).toEqual([hash]);
		expect(await servedGeneration(asUser(ALICE), now.generations[0].id)).toMatchObject({ wrapped: first.wrapped, hash });
	});

	it("serves a generation only by an id on the caller's own list: Bob gets 404 for Alice's id, and a path-shaped id reads nothing", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		const { hash } = await served(asUser(ALICE));
		await put(asUser(ALICE), { ...(await wrapFor()), recipient: first.recipient, replaces: hash });
		const [{ id }] = ((await served(asUser(ALICE))) as unknown as { generations: { id: string }[] }).generations;
		await put(asUser(BOB), await wrapFor());
		reads.length = 0;
		await expect(servedGeneration(asUser(BOB), id)).rejects.toMatchObject({ status: 404 });
		await expect(servedGeneration(asUser(ALICE), `../../user/${BOB}.history.age`)).rejects.toMatchObject({ status: 404 });
		expect(reads.filter((p) => !p.endsWith(".history.recipient") && !p.endsWith(".history.generations"))).toEqual([]);
	});

	it("refuses with 409 the second of two rewraps made from the same read, keeping the first one's change", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		const { hash: stale } = await served(asUser(ALICE));
		const tabA = { ...(await wrapFor()), recipient: first.recipient, replaces: stale };
		const tabB = { ...(await wrapFor()), recipient: first.recipient, replaces: stale };
		expect((await put(asUser(ALICE), tabA)).status).toBe(200);
		await expect(put(asUser(ALICE), tabB)).rejects.toMatchObject({ status: 409 });
		expect((await served(asUser(ALICE))).wrapped).toBe(tabA.wrapped);
	});

	it("refuses with 409 a rewrap that names no wrap it replaces", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		await expect(put(asUser(ALICE), { ...(await wrapFor()), recipient: first.recipient })).rejects.toMatchObject({ status: 409 });
		expect(await served(asUser(ALICE))).toMatchObject(first);
	});

	it("takes the file key's own lock, so a wipe of the file key and a history write serialize", async () => {
		await put(asUser(ALICE), await wrapFor());
		expect(lockNames).toEqual([`custodial-key:users:${ALICE}`]);
	});

	it("refuses with 413, storing nothing, a body whose content-length is over the cap", async () => {
		await expect(putRaw(asUser(ALICE), "{}", { "content-length": String(10 * 1024 * 1024) })).rejects.toMatchObject({ status: 413 });
		expect(store.size).toBe(0);
	});

	it("refuses with 413 an over-cap body sent with no content-length, and stops reading it", async () => {
		let pulled = 0;
		const chunk = new Uint8Array(8 * 1024).fill(0x20);
		const endless = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled++;
				c.enqueue(chunk);
			},
		});
		await expect(putRaw(asUser(ALICE), endless)).rejects.toMatchObject({ status: 413 });
		expect(pulled).toBeLessThan(10);
		expect(store.size).toBe(0);
	});

	it("refuses with 400 a wrap that is not an age file, and stores nothing", async () => {
		const ok = await wrapFor();
		await expect(put(asUser(ALICE), { ...ok, wrapped: Buffer.from("AGE-SECRET-KEY-PQ-1 plaintext").toString("base64") })).rejects.toMatchObject({ status: 400 });
		expect(store.size).toBe(0);
	});

	it("refuses with 400 a recipient that is not a hybrid age recipient, so sealing never falls to X25519 alone", async () => {
		const ok = await wrapFor();
		const x25519 = await identityToRecipient(await generateX25519Identity());
		await expect(put(asUser(ALICE), { ...ok, recipient: x25519 })).rejects.toMatchObject({ status: 400 });
		expect(store.size).toBe(0);
	});

	it("answers 410 to GET and PUT once the owner's history key is tombstoned", async () => {
		const alice = await wrapFor();
		await put(asUser(ALICE), alice);
		const recipientPath = [...store.keys()].find((p) => p.includes(ALICE) && p.endsWith(".history.recipient"))!;
		store.set(recipientPath, new TextEncoder().encode(KEY_TOMBSTONE));
		await expect(get(asUser(ALICE))).rejects.toMatchObject({ status: 410 });
		await expect(put(asUser(ALICE), { ...alice, replaces: "anything" })).rejects.toMatchObject({ status: 410 });
	});
});

describe("history key route after a wipe", () => {
	const bucket = {
		read: async (p: string) => store.get(p) ?? null,
		write: async (p: string, bytes: Uint8Array) => void store.set(p, bytes),
	};
	const lock = <T>(name: string, fn: () => Promise<T>) => {
		lockNames.push(name);
		return fn();
	};

	it("account deletion: GET and PUT answer 410, every history object is the tombstone, and sealing reads no recipient", async () => {
		const alice = await wrapFor();
		await put(asUser(ALICE), alice);
		const { hash } = await served(asUser(ALICE));
		await put(asUser(ALICE), { ...(await wrapFor()), recipient: alice.recipient, replaces: hash });
		const before = [...store.keys()].filter((p) => p.includes(ALICE) && p.includes(".history."));
		// Two generations, the list, the current wrap and the recipient.
		expect(before).toHaveLength(5);
		await tombstoneHistoryKey(ownerGrant("users", ALICE), bucket, lock);
		const paths = [...store.keys()].filter((p) => p.includes(ALICE) && p.includes(".history."));
		expect(paths.sort()).toEqual([...before, `_keys/user/${ALICE}.history.age.prev`].sort());
		for (const p of paths) expect(new TextDecoder().decode(store.get(p)), p).toBe(KEY_TOMBSTONE);
		expect(lockNames).toContain(`custodial-key:users:${ALICE}`);
		await expect(get(asUser(ALICE))).rejects.toMatchObject({ status: 410 });
		await expect(put(asUser(ALICE), await wrapFor())).rejects.toMatchObject({ status: 410 });
		await expect(readHistoryRecipient(ownerGrant("users", ALICE), bucket)).rejects.toMatchObject({ code: "key_tombstoned" });
	});

	it("account deletion closes the slot for an owner who never enrolled, so a later PUT is refused too", async () => {
		await tombstoneHistoryKey(ownerGrant("users", BOB), bucket, lock);
		await expect(put(asUser(BOB), await wrapFor())).rejects.toMatchObject({ status: 410 });
	});

	it("Forget everything: the old wrap is destroyed, GET answers 404, and a new key with a new recipient is accepted", async () => {
		const first = await wrapFor();
		await put(asUser(ALICE), first);
		const wrapPath = `_keys/user/${ALICE}.history.age`;
		const oldWrap = store.get(wrapPath)!;
		await resetHistoryKey(ownerGrant("users", ALICE), bucket, lock);
		expect(Buffer.compare(Buffer.from(store.get(wrapPath)!), Buffer.from(oldWrap))).not.toBe(0);
		// No object anywhere still holds the old wrap, generations included.
		for (const [p, bytes] of store) expect(Buffer.compare(Buffer.from(bytes), Buffer.from(oldWrap)), p).not.toBe(0);
		await expect(get(asUser(ALICE))).rejects.toMatchObject({ status: 404 });
		expect(await readHistoryRecipient(ownerGrant("users", ALICE), bucket)).toBeNull();

		const second = await wrapFor();
		expect(second.recipient).not.toBe(first.recipient);
		const res = await put(asUser(ALICE), second);
		expect(res.status).toBe(201);
		expect((await served(asUser(ALICE))).recipient).toBe(second.recipient);
		expect(await readHistoryRecipient(ownerGrant("users", ALICE), bucket)).toBe(second.recipient);
	});
});

describe("history key route: junk rewraps from a stolen session never destroy the wrap the owner opens", () => {
	/** A wrap of a fresh history identity to one X25519 "device" key, which stands in for the browser's
	 *  device CryptoKey: the same age stanza type, openable here in Node. */
	async function ownerWrap() {
		const identity = await generateHybridIdentity();
		const recipient = await identityToRecipient(identity);
		const device = await generateX25519Identity();
		const e = new Encrypter();
		e.addRecipient(await identityToRecipient(device));
		const wrapped = await e.encrypt(JSON.stringify({ v: 1, identity, recipients: [] }));
		return { device, identity, body: { wrapped: Buffer.from(wrapped).toString("base64"), recipient } };
	}

	/** An age file to a key nobody holds: passes every shape check the route makes. */
	async function junk(): Promise<string> {
		const e = new Encrypter();
		e.addRecipient(await identityToRecipient(await generateX25519Identity()));
		return Buffer.from(await e.encrypt("junk")).toString("base64");
	}

	/** Every wrap GET can serve this caller, newest first: the current one, then each older generation. */
	async function everyServedWrap(locals: object): Promise<string[]> {
		const current = (await (await get(locals)).json()) as { wrapped: string; generations?: { id: string }[] };
		const older: string[] = [];
		for (const g of current.generations ?? []) {
			const url = new URL(`${URL_}?generation=${encodeURIComponent(g.id)}`);
			// @ts-expect-error - RequestEvent is heavier than this test needs
			const res = await GET({ locals, request: new Request(url), url });
			older.push(((await res.json()) as { wrapped: string }).wrapped);
		}
		return [current.wrapped, ...older];
	}

	/** Open a served wrap with the device key, as the browser's unlock does; null when it will not open. */
	async function openWith(device: string, wrapped: string): Promise<string | null> {
		const d = new Decrypter();
		d.addIdentity(device);
		try {
			return (JSON.parse(await d.decrypt(new Uint8Array(Buffer.from(wrapped, "base64")), "text")) as { identity: string }).identity;
		} catch {
			return null;
		}
	}

	it("after two junk rewraps naming the current hash, GET still serves the original wrap, and the owner's device key opens it", async () => {
		const owner = await ownerWrap();
		expect((await put(asUser(ALICE), owner.body)).status).toBe(201);
		for (let i = 0; i < 2; i++) {
			const { hash } = await served(asUser(ALICE));
			expect((await put(asUser(ALICE), { wrapped: await junk(), recipient: owner.body.recipient, replaces: hash })).status).toBe(200);
		}
		const wraps = await everyServedWrap(asUser(ALICE));
		const opened = await Promise.all(wraps.map((w) => openWith(owner.device, w)));
		expect(opened[0], "the newest wrap is the junk one").toBeNull();
		expect(opened.filter((o) => o !== null), "no served generation opens with the owner's device key").toEqual([owner.identity]);
	});

	it("refuses with 429 the next PUT once an owner has made 10 in a day, storing nothing, and leaves another owner's PUTs alone", async () => {
		const owner = await ownerWrap();
		await put(asUser(ALICE), owner.body);
		for (let i = 0; i < 9; i++) {
			const { hash } = await served(asUser(ALICE));
			await put(asUser(ALICE), { wrapped: await junk(), recipient: owner.body.recipient, replaces: hash });
		}
		const { hash } = await served(asUser(ALICE));
		const objects = store.size;
		await expect(put(asUser(ALICE), { wrapped: await junk(), recipient: owner.body.recipient, replaces: hash })).rejects.toMatchObject({ status: 429 });
		expect(store.size).toBe(objects);
		expect((await served(asUser(ALICE))).hash).toBe(hash);
		expect((await put(asUser(BOB), await wrapFor())).status).toBe(201);
	});

	it("an owner stored before generations existed keeps the current wrap as a generation, and never the .prev before it", async () => {
		const owner = await ownerWrap();
		await put(asUser(ALICE), owner.body);
		// The first version's layout: a current wrap, its .prev, and no generations list. A .prev from back
		// then may be the wrap before a removal, and nothing tells it from junk, so it stays out of reach.
		const current = await junk();
		for (const p of [...store.keys()]) if (p.includes(".history.age.") || p.endsWith(".history.generations")) store.delete(p);
		store.set(`_keys/user/${ALICE}.history.age.prev`, new Uint8Array(Buffer.from(owner.body.wrapped, "base64")));
		store.set(`_keys/user/${ALICE}.history.age`, new Uint8Array(Buffer.from(current, "base64")));
		const { hash } = await served(asUser(ALICE));
		await put(asUser(ALICE), { wrapped: await junk(), recipient: owner.body.recipient, replaces: hash });
		expect((await everyServedWrap(asUser(ALICE))).slice(1)).toEqual([current]);
	});

	it("refuses with 400 a PUT from a page that does not declare format 2, storing nothing", async () => {
		const res = putRaw(asUser(ALICE), JSON.stringify(await wrapFor()));
		await expect(res).rejects.toMatchObject({ status: 400 });
		expect(store.size).toBe(0);
	});
});

describe("history key route: turning encryption on seals the account's existing chats", () => {
	it("seals only the caller's own chats, once, on the PUT that creates the key, and not on a rewrap", async () => {
		const first = await wrapFor();
		const res = await put(asUser(ALICE), first);
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ created: true, existingChats: "sealed" });
		expect(sealing.sealOwnerHistory.mock.calls).toEqual([[ALICE]]);
		const { hash } = await served(asUser(ALICE));
		expect((await put(asUser(ALICE), { ...(await wrapFor()), recipient: first.recipient, replaces: hash })).status).toBe(200);
		expect(sealing.sealOwnerHistory).toHaveBeenCalledTimes(1);
	});

	it("still answers 201 with the key kept when the seal fails, and logs it", async () => {
		sealing.sealOwnerHistory.mockRejectedValueOnce(new Error("store down"));
		const { logger } = await import("$lib/chat/server/logger");
		const logged = vi.spyOn(logger, "error");
		const alice = await wrapFor();
		const res = await put(asUser(ALICE), alice);
		expect(res.status).toBe(201);
		// The browser is told the chats were not sealed, so it never claims they were.
		expect(await res.json()).toMatchObject({ existingChats: "not_sealed" });
		expect(await served(asUser(ALICE))).toMatchObject(alice);
		expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "history-key-opt-in-seal-failed" }), expect.any(String));
	});

	it("seals nothing for a guest's device key, or where this deployment does not seal", async () => {
		storage.guests.mockReturnValue(true);
		expect((await put(asGuest("some-guest"), await wrapFor())).status).toBe(201);
		sealing.on.mockReturnValue(false);
		const bob = await put(asUser(BOB), await wrapFor());
		expect(bob.status).toBe(201);
		expect(await bob.json()).toMatchObject({ existingChats: "not_sealed" });
		expect(sealing.sealOwnerHistory).not.toHaveBeenCalled();
	});
});
