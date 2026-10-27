// The open seam, against real age files made here with `age-encryption` itself. The fixtures
// are built by the library rather than by the module under test, so a bug in the seam can't make its
// own fixtures agree with it. (CUR-4115)
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";

const H = vi.hoisted(() => ({ config: {} as Record<string, string | undefined>, security: vi.fn(), info: vi.fn() }));

vi.mock("$lib/chat/server/config", () => ({ config: H.config }));
vi.mock("$lib/chat/server/logger", () => {
	const quiet = { info: H.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { logger: quiet, securityLogger: { ...quiet, error: H.security } };
});

import {
	CustodialCryptoError,
	KEY_TOMBSTONE,
	activeMasterKid,
	memoKeyStore,
	openCustodialObject,
	ownerGrant,
	ownerKeyPath,
	type CustodialCryptoErrorCode,
	type KeyStore,
} from "./custodialCrypto";

async function sealTo(identity: string, data: Uint8Array | string): Promise<Uint8Array> {
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(identity));
	return e.encrypt(data);
}

let master: string;
let oldMaster: string;
let alice: string;
let bob: string;
const alicesGrant = ownerGrant("users", "alice");
const bobsGrant = ownerGrant("users", "bob");
let keyObjects: Map<string, Uint8Array>;
const keys: KeyStore = { read: async (p) => keyObjects.get(p) ?? null };
// Larger than one 64 KiB age chunk, so truncation can cut a chunk rather than the header.
const plaintext = new Uint8Array(70_000).map((_, i) => i % 251);

beforeAll(async () => {
	[master, oldMaster, alice, bob] = await Promise.all([
		generateHybridIdentity(),
		generateHybridIdentity(),
		generateHybridIdentity(),
		generateHybridIdentity(),
	]);
});

beforeEach(async () => {
	H.config.CUSTODIAL_MASTER_IDENTITIES = JSON.stringify({ k2: master, k1: oldMaster });
	H.config.CUSTODIAL_MASTER_ACTIVE = "k2";
	H.security.mockReset();
	H.info.mockReset();
	keyObjects = new Map([
		[ownerKeyPath(alicesGrant), await sealTo(master, alice)],
		[ownerKeyPath(bobsGrant), await sealTo(oldMaster, bob)],
	]);
});

async function openFails(grant: typeof alicesGrant, bytes: Uint8Array): Promise<CustodialCryptoErrorCode> {
	const err = await openCustodialObject(grant, "conversations/c/s/f.bin", new Blob([bytes as BlobPart]), keys).catch((e) => e);
	expect(err).toBeInstanceOf(CustodialCryptoError);
	return (err as CustodialCryptoError).code;
}

describe("openCustodialObject", () => {
	it("opens a file sealed to its owner, byte for byte", async () => {
		const sealed = await sealTo(alice, plaintext);
		const opened = await openCustodialObject(alicesGrant, "f.bin", new Blob([sealed as BlobPart]), keys);
		expect(new Uint8Array(await opened.arrayBuffer())).toEqual(plaintext);
	});

	it("opens an owner whose key object an older master epoch wrapped", async () => {
		const sealed = await sealTo(bob, "bob's file");
		expect(await (await openCustodialObject(bobsGrant, "f", new Blob([sealed as BlobPart]), keys)).text()).toBe("bob's file");
	});

	it("passes legacy plaintext through unchanged, since every stored object is plaintext today", async () => {
		const blob = new Blob(["just a text file"]);
		expect(await openCustodialObject(alicesGrant, "f", blob, keys)).toBe(blob);
	});

	it("refuses a payload with one flipped byte as decrypt_failed, and pages", async () => {
		const sealed = await sealTo(alice, plaintext);
		sealed[sealed.length - 100] ^= 0x01;
		expect(await openFails(alicesGrant, sealed)).toBe("decrypt_failed");
		expect(H.security).toHaveBeenCalledWith(expect.objectContaining({ code: "decrypt_failed", kid: "k2" }), expect.any(String));
	});

	it("refuses a header with one flipped byte (its MAC no longer verifies) as decrypt_failed", async () => {
		const sealed = await sealTo(alice, plaintext);
		const macLine = new TextDecoder().decode(sealed.slice(0, 2000)).indexOf("\n--- ") + 6;
		sealed[macLine] = sealed[macLine] === 0x41 ? 0x42 : 0x41;
		expect(await openFails(alicesGrant, sealed)).toBe("decrypt_failed");
	});

	it("refuses a file cut short inside its last chunk's tag as decrypt_failed", async () => {
		const sealed = await sealTo(alice, plaintext);
		expect(await openFails(alicesGrant, sealed.slice(0, sealed.length - 8))).toBe("decrypt_failed");
	});

	it("refuses another owner's file under this owner's grant as no_identity_matched, never decrypting it", async () => {
		// The CUR-3180 shape: a path check let A's request reach B's object. A holds no key for it.
		const bobsFile = await sealTo(bob, "bob's private file");
		expect(await openFails(alicesGrant, bobsFile)).toBe("no_identity_matched");
	});

	it("passes an age file through unchanged when its owner has no key object, without paging, since nothing of theirs was ever sealed", async () => {
		// A person's own `backup.age`, uploaded before any key exists for them.
		const theirs = await sealTo(await generateHybridIdentity(), "their own age file");
		const opened = await openCustodialObject(ownerGrant("guests", "nobody"), "backup.age", new Blob([theirs as BlobPart]), keys);
		expect(new Uint8Array(await opened.arrayBuffer())).toEqual(theirs);
		expect(H.security).not.toHaveBeenCalled();
	});

	it("refuses a wiped owner as key_tombstoned, logged without paging", async () => {
		keyObjects.set(ownerKeyPath(alicesGrant), new TextEncoder().encode(KEY_TOMBSTONE));
		expect(await openFails(alicesGrant, await sealTo(alice, "x"))).toBe("key_tombstoned");
		expect(H.security).not.toHaveBeenCalled();
		expect(H.info).toHaveBeenCalled();
	});

	it("refuses a key object no master we hold opens as no_identity_matched", async () => {
		keyObjects.set(ownerKeyPath(alicesGrant), await sealTo(await generateHybridIdentity(), alice));
		expect(await openFails(alicesGrant, await sealTo(alice, "x"))).toBe("no_identity_matched");
	});

	it("refuses sealed bytes on a deployment with no master as master_missing", async () => {
		H.config.CUSTODIAL_MASTER_IDENTITIES = undefined;
		expect(await openFails(alicesGrant, await sealTo(alice, "x"))).toBe("master_missing");
	});

	it("refuses bytes that carry age's magic line and no valid header as not_age", async () => {
		expect(await openFails(alicesGrant, new TextEncoder().encode("age-encryption.org/v1\nnot a stanza\n"))).toBe("not_age");
	});
});

describe("memoKeyStore", () => {
	it("reads one owner's key object once across several opens, retries a read that failed, and lets the bucket error out unwrapped", async () => {
		let reads = 0;
		let fail = true;
		const memo = memoKeyStore({
			read: async (p) => {
				reads++;
				if (fail) {
					fail = false;
					throw new Error("busy");
				}
				return keys.read(p);
			},
		});
		const sealed = new Blob([(await sealTo(alice, "x")) as BlobPart]);
		// The bucket's own error comes out untouched, so readCopy's transient-error retry still applies.
		await expect(openCustodialObject(alicesGrant, "a", sealed, memo)).rejects.toThrow(/^busy$/);
		expect(H.security).not.toHaveBeenCalled();
		for (const name of ["b", "c", "d"]) expect(await (await openCustodialObject(alicesGrant, name, sealed, memo)).text()).toBe("x");
		expect(reads).toBe(2);
	});
});

describe("activeMasterKid", () => {
	it("names the active kid only when an identity for it is configured", () => {
		expect(activeMasterKid()).toBe("k2");
		H.config.CUSTODIAL_MASTER_ACTIVE = "k9";
		expect(activeMasterKid()).toBeNull();
		H.config.CUSTODIAL_MASTER_IDENTITIES = "not json";
		H.config.CUSTODIAL_MASTER_ACTIVE = "k2";
		expect(activeMasterKid()).toBeNull();
	});
});
