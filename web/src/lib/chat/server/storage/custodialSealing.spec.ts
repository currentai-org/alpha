// Sealed writes, end to end through custodialStorage against an in-memory bucket. The Hub
// is faked as a map that keeps each object's bytes and upload order; the crypto is the real module and
// the real `age-encryption`, and the fixtures that stand for a person's own age file are made by the
// library directly, so the module cannot make its own fixtures agree with it. (CUR-4116)
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	objects: new Map<string, { bytes: Uint8Array; at: number }>(),
	clock: { t: 0 },
	security: vi.fn(),
	lockHeld: new Map<string, Promise<unknown>>(),
	useLock: { on: true },
	downloadFile: vi.fn(),
	refuseDelete: new Set<string>(),
	afterUpload: { fn: null as null | ((path: string) => void) },
}));
const downloadFile = H.downloadFile;

vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));
vi.mock("$lib/chat/server/logger", () => {
	const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { logger: quiet, securityLogger: { ...quiet, error: H.security } };
});
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip: vi.fn(() => Promise.resolve()),
	clearRateLimitTrip: vi.fn(() => Promise.resolve()),
	recordCsamMatch: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop: vi.fn(), reportHitToCoop: vi.fn() }));

// The Postgres advisory lock, as an in-process mutex per name: advisoryLock.spec.ts covers the real
// one. `useLock.on = false` takes it away, which is what the concurrent-first-write test is about.
vi.mock("$lib/chat/server/db/advisoryLock", () => ({
	withAdvisoryLock: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		if (!H.useLock.on) return fn();
		const before = H.lockHeld.get(name) ?? Promise.resolve();
		const run = before.catch(() => {}).then(fn);
		H.lockHeld.set(name, run);
		return run;
	},
}));

vi.mock("@huggingface/hub", async (importOriginal) => ({
	HubApiError: (await importOriginal<typeof import("@huggingface/hub")>()).HubApiError,
	async uploadFile({ file }: { file: { path: string; content: Blob } }) {
		H.objects.set(file.path, { bytes: new Uint8Array(await file.content.arrayBuffer()), at: ++H.clock.t });
		H.afterUpload.fn?.(file.path);
	},
	downloadFile: async (a: { path: string }) => {
		H.downloadFile(a);
		const o = H.objects.get(a.path);
		return o ? new Blob([o.bytes as BlobPart]) : null;
	},
	async *listFiles({ path }: { path: string }) {
		const dir = path.endsWith("/") ? path : `${path}/`;
		for (const [p, o] of H.objects) {
			if (p === path || p.startsWith(dir)) {
				yield { type: "file", path: p, size: o.bytes.length, uploadedAt: new Date(o.at * 1000).toISOString() };
			}
		}
	},
	async deleteFile({ path }: { path: string }) {
		if (H.refuseDelete.has(path)) throw new Error("hub 500");
		H.objects.delete(path);
	},
}));

import {
	moveGuestFilesToUser,
	CustodialWipeError,
	readCustodialAttachment,
	storeChatAttachment,
	turnKeyStore,
	wipeCustodialFiles,
} from "./custodialStorage";
import { CustodialCryptoError, KEY_TOMBSTONE, ownerGrant, ownerKeyPath, ownerRecipientPath } from "./custodialCrypto";

const ME = "abc123UserId";
const SID = "guestSession123";
const AGE_MAGIC = "age-encryption.org/v1\n";
const mine = ownerGrant("users", ME);
const text = (s: string) => new Blob([s]);
const stored = (p: string) => new TextDecoder().decode(H.objects.get(p)!.bytes);
const attachment = (n: number) => `conversations/c1/${"a".repeat(63)}${n}/note${n}.txt`;

let master: string;
let stranger: string;

beforeAll(async () => {
	[master, stranger] = await Promise.all([generateHybridIdentity(), generateHybridIdentity()]);
});

beforeEach(() => {
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, {
		HF_BUCKETS_TOKEN: "hf_test",
		HF_BUCKETS_REPO: "buckets/current-ai-official/custodial-storage",
		CUSTODIAL_MASTER_IDENTITIES: JSON.stringify({ k1: master }),
		CUSTODIAL_MASTER_ACTIVE: "k1",
		CUSTODIAL_SEAL_WRITES: "true",
	});
	H.objects.clear();
	H.lockHeld.clear();
	H.useLock.on = true;
	H.refuseDelete.clear();
	H.afterUpload.fn = null;
	H.security.mockReset();
	downloadFile.mockClear();
});

describe("sealed writes (CUR-4116)", () => {
	it("stores an attachment as an age file that does not contain its plaintext, and reads it back as written", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("the quarterly numbers"));
		const bucketPath = `users/${ME}/${attachment(1)}`;
		expect(stored(bucketPath).startsWith(AGE_MAGIC)).toBe(true);
		expect(stored(bucketPath)).not.toContain("quarterly");
		expect(await (await readCustodialAttachment(ME, attachment(1)))!.text()).toBe("the quarterly numbers");
	});

	it("writes plaintext and makes no key while CUSTODIAL_SEAL_WRITES is not \"true\"", async () => {
		H.cfg.CUSTODIAL_SEAL_WRITES = "";
		await storeChatAttachment({ userId: ME }, attachment(1), text("plain"));
		expect(stored(`users/${ME}/${attachment(1)}`)).toBe("plain");
		expect(H.objects.has(ownerKeyPath(mine))).toBe(false);
	});

	it("two concurrent first writes for one owner both open, because only one key is ever made", async () => {
		await Promise.all([1, 2, 3].map((n) => storeChatAttachment({ userId: ME }, attachment(n), text(`file ${n}`))));
		for (const n of [1, 2, 3]) {
			expect(await (await readCustodialAttachment(ME, attachment(n)))!.text()).toBe(`file ${n}`);
		}
		expect(H.security).not.toHaveBeenCalled();
	});

	it("refuses a write after a wipe tombstoned the owner's recipient, and stores nothing", async () => {
		H.objects.set(ownerRecipientPath(mine), { bytes: new TextEncoder().encode(KEY_TOMBSTONE), at: ++H.clock.t });
		const err = await storeChatAttachment({ userId: ME }, attachment(1), text("after the wipe")).catch((e) => e);
		expect(err).toBeInstanceOf(CustodialCryptoError);
		expect((err as CustodialCryptoError).code).toBe("key_tombstoned");
		expect(H.objects.has(`users/${ME}/${attachment(1)}`)).toBe(false);
	});

	it("refuses a write when only the key object was tombstoned, and mints no fresh key", async () => {
		H.objects.set(ownerKeyPath(mine), { bytes: new TextEncoder().encode(KEY_TOMBSTONE), at: ++H.clock.t });
		const err = await storeChatAttachment({ userId: ME }, attachment(1), text("after the wipe")).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("key_tombstoned");
		expect(stored(ownerKeyPath(mine))).toBe(KEY_TOMBSTONE);
		expect(H.objects.has(ownerRecipientPath(mine))).toBe(false);
	});

	it("refuses every write on a deployment with sealing on and no master, rather than storing plaintext", async () => {
		H.cfg.CUSTODIAL_MASTER_IDENTITIES = "";
		const err = await storeChatAttachment({ userId: ME }, attachment(1), text("x")).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("master_missing");
		expect(H.objects.size).toBe(0);
	});

	it("a person's own age file, stored as plaintext before their key existed, downloads unchanged afterwards and pages nothing", async () => {
		const toStranger = new Encrypter();
		toStranger.addRecipient(await identityToRecipient(stranger));
		const backup = await toStranger.encrypt("my own backup");
		H.cfg.CUSTODIAL_SEAL_WRITES = "";
		await storeChatAttachment({ userId: ME }, attachment(1), new Blob([backup as BlobPart]));
		H.cfg.CUSTODIAL_SEAL_WRITES = "true";
		await storeChatAttachment({ userId: ME }, attachment(2), text("first sealed write makes the key"));
		expect(H.objects.has(ownerKeyPath(mine))).toBe(true);

		const back = await readCustodialAttachment(ME, attachment(1));
		expect(new Uint8Array(await back!.arrayBuffer())).toEqual(backup);
		expect(H.security).not.toHaveBeenCalled();
	});

	it("still pages for an age file that won't open when it was stored after the owner's key", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("makes the key"));
		const toStranger = new Encrypter();
		toStranger.addRecipient(await identityToRecipient(stranger));
		// Written straight to the bucket after the key, as a swapped object would be.
		H.objects.set(`users/${ME}/${attachment(2)}`, { bytes: await toStranger.encrypt("swapped in"), at: ++H.clock.t });
		const err = await readCustodialAttachment(ME, attachment(2)).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("no_identity_matched");
		expect(H.security).toHaveBeenCalledTimes(1);
	});

	it("a turn opening several of one owner's attachments reads their key object once", async () => {
		for (const n of [1, 2, 3]) await storeChatAttachment({ userId: ME }, attachment(n), text(`file ${n}`));
		downloadFile.mockClear();
		const keys = turnKeyStore();
		for (const n of [1, 2, 3]) await readCustodialAttachment(ME, attachment(n), keys);
		const keyReads = downloadFile.mock.calls.filter(([a]) => a.path === ownerKeyPath(mine));
		expect(keyReads).toHaveLength(1);
	});

	it("a guest's attachment opens under the account after sign-in, sealed again to the account's key", async () => {
		await storeChatAttachment({ guestSessionId: SID }, attachment(1), text("written as a guest"));
		expect(stored(`guests/${SID}/${attachment(1)}`).startsWith(AGE_MAGIC)).toBe(true);
		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 1, failed: 0, overQuota: 0 });
		expect(stored(`users/${ME}/${attachment(1)}`).startsWith(AGE_MAGIC)).toBe(true);
		expect(await (await readCustodialAttachment(ME, attachment(1)))!.text()).toBe("written as a guest");
	});

});

describe("Forget everything keeps the account able to upload (CUR-4415)", () => {
	it("an upload after a kept-account wipe succeeds and reads back", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("before"));
		await wipeCustodialFiles(ME, { keepAccount: true });
		await storeChatAttachment({ userId: ME }, attachment(2), text("after the wipe"));
		expect(stored(`users/${ME}/${attachment(2)}`).startsWith(AGE_MAGIC)).toBe(true);
		expect(await (await readCustodialAttachment(ME, attachment(2)))!.text()).toBe("after the wipe");
	});

	it("a kept-account wipe records each step's time and both lock waits for its log line (CUR-4548)", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("before"));
		const timing: Record<string, number> = {};
		await wipeCustodialFiles(ME, { keepAccount: true, timing });
		expect(Object.keys(timing).sort()).toEqual(
			[
				"deleteMs",
				"files",
				"listMs",
				"replaceLockHeldMs",
				"replaceLockWaitMs",
				"replaceMs",
				"tombstoneLockHeldMs",
				"tombstoneLockWaitMs",
				"tombstoneMs",
			].sort()
		);
		expect(timing.files).toBe(1);
	});

	it("a file sealed before the wipe does not open under the new key", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("kept in a backup"));
		const before = H.objects.get(`users/${ME}/${attachment(1)}`)!;
		await wipeCustodialFiles(ME, { keepAccount: true });
		// The backup copy comes back after the new key was made, so it is not passed through as legacy.
		H.objects.set(`users/${ME}/${attachment(1)}`, { bytes: before.bytes, at: ++H.clock.t });
		const err = await readCustodialAttachment(ME, attachment(1)).catch((e) => e);
		expect(err).toBeInstanceOf(CustodialCryptoError);
		expect((err as CustodialCryptoError).code).toBe("no_identity_matched");
	});

	it("a failed delete keeps the tombstone, so nothing is written until the wipe is retried", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("x"));
		H.refuseDelete.add(`users/${ME}/${attachment(1)}`);
		await expect(wipeCustodialFiles(ME, { keepAccount: true })).rejects.toBeInstanceOf(CustodialWipeError);
		expect(stored(ownerRecipientPath(mine))).toBe(KEY_TOMBSTONE);
		H.refuseDelete.clear();
		await wipeCustodialFiles(ME, { keepAccount: true });
		await storeChatAttachment({ userId: ME }, attachment(2), text("after the retry"));
		expect(await (await readCustodialAttachment(ME, attachment(2)))!.text()).toBe("after the retry");
	});
});

describe("account wipe destroys the key first (CUR-4117)", () => {
	it("a wiped account's file that a failed delete left behind fails to open as tombstoned", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("kept by a failed delete"));
		await storeChatAttachment({ userId: ME }, attachment(2), text("deleted"));
		H.refuseDelete.add(`users/${ME}/${attachment(1)}`);

		await expect(wipeCustodialFiles(ME)).rejects.toBeInstanceOf(CustodialWipeError);
		expect(stored(`users/${ME}/${attachment(1)}`).startsWith(AGE_MAGIC)).toBe(true);
		const err = await readCustodialAttachment(ME, attachment(1)).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("key_tombstoned");
		expect(H.security).not.toHaveBeenCalled();
	});

	it("tombstones the recipient before the key object, and both before any file is deleted", async () => {
		await storeChatAttachment({ userId: ME }, attachment(1), text("x"));
		const order: string[] = [];
		const watch = new Proxy(H.objects, {
			get(target, prop) {
				if (prop === "set") return (k: string, v: { bytes: Uint8Array; at: number }) => (order.push(`write ${k}`), target.set(k, v));
				if (prop === "delete") return (k: string) => (order.push(`delete ${k}`), target.delete(k));
				const v = Reflect.get(target, prop);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const original = H.objects;
		H.objects = watch;
		try {
			await wipeCustodialFiles(ME);
		} finally {
			H.objects = original;
		}
		expect(order).toEqual([`write ${ownerRecipientPath(mine)}`, `write ${ownerKeyPath(mine)}`, `delete users/${ME}/${attachment(1)}`]);
	});

	it("refuses a write that starts after the wipe, for an owner who never had a key too", async () => {
		await wipeCustodialFiles(ME);
		const err = await storeChatAttachment({ userId: ME }, attachment(1), text("too late")).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("key_tombstoned");
		expect(H.objects.has(`users/${ME}/${attachment(1)}`)).toBe(false);
	});

	it("a wipe landing while a first write is making the key cannot leave a live key behind it", async () => {
		// The wipe starts in the gap between key creation's two writes, the key object and the recipient.
		let wipe: Promise<unknown> = Promise.resolve();
		H.afterUpload.fn = (p) => {
			if (p !== ownerKeyPath(mine)) return;
			H.afterUpload.fn = null;
			wipe = wipeCustodialFiles(ME);
		};
		await storeChatAttachment({ userId: ME }, attachment(1), text("racing")).catch(() => {});
		await wipe;
		expect(stored(ownerRecipientPath(mine))).toBe(KEY_TOMBSTONE);
		expect(stored(ownerKeyPath(mine))).toBe(KEY_TOMBSTONE);
		const err = await storeChatAttachment({ userId: ME }, attachment(2), text("after")).catch((e) => e);
		expect((err as CustodialCryptoError).code).toBe("key_tombstoned");
	});
});
