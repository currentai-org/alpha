// The move off Hugging Face, end to end: sealed files are written into a faked Hugging Face
// bucket through the app's own upload path, with the real crypto and the real `age-encryption`, then
// moved into the real local-disk backend and read back through the app's own read path.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHybridIdentity } from "age-encryption";

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	objects: new Map<string, { bytes: Uint8Array; at: number }>(),
	clock: { t: 0 },
}));

vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));
vi.mock("$lib/chat/server/logger", () => {
	const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { logger: quiet, securityLogger: quiet };
});
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip: vi.fn(() => Promise.resolve()),
	clearRateLimitTrip: vi.fn(() => Promise.resolve()),
	recordCsamMatch: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop: vi.fn(), reportHitToCoop: vi.fn() }));
vi.mock("$lib/chat/server/db/advisoryLock", () => ({ withAdvisoryLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));

// The Hugging Face bucket, faked at the @huggingface/hub boundary the HF backend calls.
vi.mock("@huggingface/hub", async (importOriginal) => ({
	HubApiError: (await importOriginal<typeof import("@huggingface/hub")>()).HubApiError,
	async uploadFile({ file }: { file: { path: string; content: Blob } }) {
		H.objects.set(file.path, { bytes: new Uint8Array(await file.content.arrayBuffer()), at: ++H.clock.t });
	},
	downloadFile: async ({ path: p }: { path: string }) => {
		const o = H.objects.get(p);
		return o ? new Blob([o.bytes as BlobPart]) : null;
	},
	async *listFiles({ path: p }: { path?: string }) {
		const dir = p ? (p.endsWith("/") ? p : `${p}/`) : "";
		for (const [k, o] of H.objects) {
			if (!p || k === p || k.startsWith(dir)) {
				yield { type: "file", path: k, size: o.bytes.length, uploadedAt: new Date(o.at * 1000).toISOString() };
			}
		}
	},
	async deleteFile({ path: p }: { path: string }) {
		H.objects.delete(p);
	},
}));

import { custodialBackend, hfBucketBackend } from "./custodialBackend";
import { moveCustodialObjects } from "./custodialMove";
import { downloadCustodialFile, readCustodialAttachment, storeChatAttachment } from "./custodialStorage";
import { CustodialCryptoError } from "./custodialCrypto";

const OWNER = "ownerUserId1";
const OTHER = "otherUserId2";
const AGE_MAGIC = "age-encryption.org/v1\n";
const attachment = (n: number) => `conversations/c1/${"a".repeat(63)}${n}/note${n}.txt`;

let master: string;
let dir: string;

/** Every file under the local store, as object path → bytes. */
async function localObjects(): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>();
	for (const name of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!name.isFile()) continue;
		const full = path.join(name.parentPath, name.name);
		out.set(path.relative(dir, full).split(path.sep).join("/"), new Uint8Array(await readFile(full)));
	}
	return out;
}

beforeAll(async () => {
	master = await generateHybridIdentity();
});

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "custodial-move-"));
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, {
		CUSTODIAL_STORAGE_BACKEND: "hf",
		HF_BUCKETS_TOKEN: "hf_test",
		HF_BUCKETS_REPO: "buckets/test-owner/custodial-fixture",
		CUSTODIAL_MASTER_IDENTITIES: JSON.stringify({ k1: master }),
		CUSTODIAL_MASTER_ACTIVE: "k1",
		CUSTODIAL_SEAL_WRITES: "true",
		CUSTODIAL_LOCAL_DIR: dir,
	});
	H.objects.clear();
	// The fixture: two people's sealed files in the Hugging Face bucket, each with its own key objects.
	await storeChatAttachment({ userId: OWNER }, attachment(1), new Blob(["the owner's first note"]));
	await storeChatAttachment({ userId: OWNER }, attachment(2), new Blob(["the owner's second note"]));
	await storeChatAttachment({ userId: OTHER }, attachment(1), new Blob(["someone else's note"]));
	// From here on the deployment is configured for the new store, as it is when the move runs.
	H.cfg.CUSTODIAL_STORAGE_BACKEND = "local";
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("moving custodial objects off Hugging Face", () => {
	it("run twice, leaves each Hugging Face object once in the new store with identical bytes, and the second run copies nothing", async () => {
		const target = await custodialBackend();
		expect(target.kind).toBe("local");

		const first = await moveCustodialObjects(hfBucketBackend, target);
		const second = await moveCustodialObjects(hfBucketBackend, target);

		expect(first).toMatchObject({ seen: H.objects.size, copied: H.objects.size, skipped: 0, conflicts: 0, failed: 0 });
		expect(second).toMatchObject({ seen: H.objects.size, copied: 0, skipped: H.objects.size, conflicts: 0, failed: 0 });
		const moved = await localObjects();
		// Exactly the source's objects, once each, with no partial files left beside them.
		expect([...moved.keys()].sort()).toEqual([...H.objects.keys()].sort());
		for (const [p, o] of H.objects) expect(moved.get(p)).toEqual(o.bytes);
		// Still ciphertext at rest: the move copied the sealed bytes, it never opened them.
		const ownerFile = new TextDecoder().decode(moved.get(`users/${OWNER}/${attachment(1)}`));
		expect(ownerFile.startsWith(AGE_MAGIC)).toBe(true);
		expect(ownerFile).not.toContain("first note");
	});

	it("after the move, the owner's file opens through the app's read path and another person's read of it is refused", async () => {
		await moveCustodialObjects(hfBucketBackend, await custodialBackend());
		await moveCustodialObjects(hfBucketBackend, await custodialBackend());
		// The source is gone, so every read below can only be served by the new store.
		H.objects.clear();

		expect(await (await readCustodialAttachment(OWNER, attachment(1)))!.text()).toBe("the owner's first note");
		expect(await (await downloadCustodialFile(OWNER, `users/${OWNER}/${attachment(2)}`))!.text()).toBe("the owner's second note");

		// Another account asking for the owner's file by path is refused by ownership.
		await expect(downloadCustodialFile(OTHER, `users/${OWNER}/${attachment(1)}`)).rejects.toThrow();
		// And the owner's ciphertext placed under the other account's own folder does not open with their key.
		const target = await custodialBackend();
		const ownerBytes = await target.get(`users/${OWNER}/${attachment(1)}`);
		await target.put(`users/${OTHER}/${attachment(9)}`, ownerBytes!);
		const err = await readCustodialAttachment(OTHER, attachment(9)).catch((e) => e);
		expect(err).toBeInstanceOf(CustodialCryptoError);
		expect((err as CustodialCryptoError).code).toBe("no_identity_matched");
	});

	it("a dry run reports what it would copy and writes nothing", async () => {
		const totals = await moveCustodialObjects(hfBucketBackend, await custodialBackend(), { dryRun: true });
		expect(totals).toMatchObject({ seen: H.objects.size, copied: H.objects.size, failed: 0 });
		expect(totals.copiedBytes).toBe([...H.objects.values()].reduce((n, o) => n + o.bytes.length, 0));
		expect((await localObjects()).size).toBe(0);
	});

	it("leaves an object the destination already holds at a different size alone, and counts it as a conflict", async () => {
		const target = await custodialBackend();
		const p = `users/${OWNER}/${attachment(1)}`;
		await target.put(p, new Blob(["written by the app after the switch"]));
		const totals = await moveCustodialObjects(hfBucketBackend, target);
		expect(totals.conflicts).toBe(1);
		expect(totals.copied).toBe(H.objects.size - 1);
		expect(await (await target.get(p))!.text()).toBe("written by the app after the switch");
	});

	it("with verify, a same-size object whose bytes differ is a conflict, not a skip", async () => {
		const target = await custodialBackend();
		const p = `users/${OWNER}/${attachment(1)}`;
		await target.put(p, new Blob([new Uint8Array(H.objects.get(p)!.bytes.length)]));
		expect((await moveCustodialObjects(hfBucketBackend, target)).conflicts).toBe(0);
		expect((await moveCustodialObjects(hfBucketBackend, target, { verify: true })).conflicts).toBe(1);
	});
});
