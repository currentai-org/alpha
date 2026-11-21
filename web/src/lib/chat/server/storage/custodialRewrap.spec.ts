// The KMS rewrap of owner key objects. KMS is faked at the ReEncrypt seam as a key store that hands out
// opaque handles and refuses a blob whose source key or owner context differs from the wrap's, which is
// the behaviour of real KMS this module leans on. The backend is in memory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustodialBackend, StoredFile } from "./custodialBackend";

vi.mock("$lib/chat/server/config", () => ({ config: {} }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@vercel/oidc-aws-credentials-provider", () => ({ awsCredentialsProvider: vi.fn() }));

import { formatRewrapTotals, rewrapOwnerKeys } from "./custodialRewrap";
import { KEY_TOMBSTONE } from "./custodialCrypto";

const OLD = "arn:aws:kms:us-west-2:111111111111:key/old";
const NEW = "arn:aws:kms:eu-central-1:222222222222:key/new";
const MAGIC = "alpha-custodial-kms-v1\n";
const kmsKeys = new Map([["old-kid", OLD], ["new-kid", NEW], ["other-kid", "arn:aws:kms:us-west-2:111111111111:key/other"]]);

let store: Map<string, Uint8Array>;
let wraps: Map<string, { keyId: string; context: string; secret: string }>;
let reencryptCalls: { from: string; to: string }[];
let midRun: (() => void) | null;

const backend = (): CustodialBackend => ({
	kind: "local",
	async get(p) { const b = store.get(p); return b ? new Blob([new Uint8Array(b)]) : null; },
	async put(p, c) { store.set(p, new Uint8Array(await c.arrayBuffer())); },
	async delete(p) { store.delete(p); },
	async *list(prefix) {
		for (const [path, b] of [...store]) if (path.startsWith(prefix)) yield { type: "file", path, size: b.length } as StoredFile;
	},
	async stat(p) { const b = store.get(p); return b ? ({ type: "file", path: p, size: b.length } as StoredFile) : null; },
});

/** What a ReEncrypt in KMS does: opens under the source key and context, wraps under the destination. */
const reencrypt = async (from: string, to: string, blob: Uint8Array, ctx: Record<string, string>) => {
	reencryptCalls.push({ from, to });
	midRun?.();
	const w = wraps.get(new TextDecoder().decode(blob));
	if (!w || w.keyId !== from || w.context !== JSON.stringify(ctx)) throw Object.assign(new Error("refused"), { name: "InvalidCiphertextException" });
	const handle = crypto.randomUUID();
	wraps.set(handle, { keyId: to, context: w.context, secret: w.secret });
	return new TextEncoder().encode(handle);
};

/** A key object as the app writes one, wrapped under `kid` for the owner. */
function putKeyObject(kind: "user" | "guest", id: string, kid: string, arn: string) {
	const handle = crypto.randomUUID();
	wraps.set(handle, { keyId: arn, context: JSON.stringify({ "alpha-custodial-owner": `${kind}s:${id}` }), secret: `AGE-SECRET-KEY-PQ-1${id}` });
	store.set(`_keys/${kind}/${id}.age`, new TextEncoder().encode(`${MAGIC}${kid}\n${Buffer.from(handle).toString("base64")}\n`));
}
const kidOf = (p: string) => new TextDecoder().decode(store.get(p)!).split("\n")[1];
const snapshot = () => JSON.stringify([...store].map(([k, v]) => [k, [...v]]));

beforeEach(() => {
	store = new Map();
	wraps = new Map();
	reencryptCalls = [];
	midRun = null;
	putKeyObject("user", "u1", "old-kid", OLD);
	putKeyObject("user", "u2", "old-kid", OLD);
	putKeyObject("guest", "g1", "old-kid", OLD);
	putKeyObject("user", "u3", "new-kid", NEW);
	putKeyObject("user", "u4", "other-kid", "arn:aws:kms:us-west-2:111111111111:key/other");
	store.set("_keys/user/u5.age", new TextEncoder().encode(KEY_TOMBSTONE));
	store.set("_keys/user/u6.age", new TextEncoder().encode("-----BEGIN AGE ENCRYPTED FILE-----\nx\n"));
	store.set("_keys/user/u1.recipient", new TextEncoder().encode("age1pq...\n"));
	store.set("users/u1/file.age", new TextEncoder().encode("sealed"));
});

const run = (o: { dryRun?: boolean; from?: string[]; to?: string } = {}) =>
	rewrapOwnerKeys(backend(), { kmsKeys, from: o.from ?? ["old-kid"], to: o.to ?? "new-kid", dryRun: o.dryRun, reencrypt });

describe("rewrapping custodial owner keys between KMS keys", () => {
	it("a run with no flags counts what it would move and writes nothing", async () => {
		const before = snapshot();
		const t = await run();
		expect(t).toMatchObject({ seen: 7, rewrapped: 3, alreadyTarget: 1, otherKid: 1, tombstoned: 1, notKms: 1, remainingOnSource: 3, failed: 0 });
		expect(snapshot()).toBe(before);
		expect(reencryptCalls).toHaveLength(0);
	});

	it("an applied run moves every old-kid key object onto the new key and leaves nothing on the old kid", async () => {
		const t = await run({ dryRun: false });
		expect(t).toMatchObject({ rewrapped: 3, remainingOnSource: 0, failed: 0, conflicts: 0 });
		for (const p of ["_keys/user/u1.age", "_keys/user/u2.age", "_keys/guest/g1.age"]) expect(kidOf(p)).toBe("new-kid");
		expect(reencryptCalls.every((c) => c.from === OLD && c.to === NEW)).toBe(true);
		// Files, recipients, other kids, tombstones and age-wrapped objects are untouched.
		expect(new TextDecoder().decode(store.get("users/u1/file.age"))).toBe("sealed");
		expect(kidOf("_keys/user/u4.age")).toBe("other-kid");
		expect(new TextDecoder().decode(store.get("_keys/user/u5.age"))).toBe(KEY_TOMBSTONE);
	});

	it("the rewrapped key still opens for its own owner under the new key and context, and the old wrapped copy is kept", async () => {
		const oldBytes = store.get("_keys/user/u1.age")!;
		await run({ dryRun: false });
		const newHandle = Buffer.from(new TextDecoder().decode(store.get("_keys/user/u1.age")!).split("\n")[2], "base64").toString();
		const w = wraps.get(newHandle)!;
		expect(w.keyId).toBe(NEW);
		expect(w.context).toBe(JSON.stringify({ "alpha-custodial-owner": "users:u1" }));
		expect(w.secret).toBe("AGE-SECRET-KEY-PQ-1u1"); // same identity, moved inside KMS
		expect(store.get("_rewrap/old-kid/user/u1.age")).toEqual(oldBytes);
		expect(store.has("_rewrap/old-kid/guest/g1.age")).toBe(true);
	});

	it("run twice, the second run moves nothing and calls KMS not at all", async () => {
		await run({ dryRun: false });
		const calls = reencryptCalls.length;
		const second = await run({ dryRun: false });
		expect(second).toMatchObject({ rewrapped: 0, alreadyTarget: 4, remainingOnSource: 0 });
		expect(reencryptCalls).toHaveLength(calls);
	});

	it("a run stopped partway resumes: the finished owners are skipped and the rest move", async () => {
		let n = 0;
		const flaky = async (...a: Parameters<typeof reencrypt>) => {
			if (++n === 2) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
			return reencrypt(...a);
		};
		const first = await rewrapOwnerKeys(backend(), { kmsKeys, from: ["old-kid"], to: "new-kid", dryRun: false, reencrypt: flaky });
		expect(first).toMatchObject({ rewrapped: 2, failed: 1, remainingOnSource: 1, failures: { ThrottlingException: 1 } });
		const second = await run({ dryRun: false });
		expect(second).toMatchObject({ rewrapped: 1, remainingOnSource: 0, failed: 0 });
	});

	it("a key object copied onto another owner's path is refused by KMS, counted as a failure and left as found", async () => {
		store.set("_keys/user/u2.age", store.get("_keys/user/u1.age")!);
		const t = await run({ dryRun: false });
		expect(t.failures).toEqual({ InvalidCiphertextException: 1 });
		expect(kidOf("_keys/user/u2.age")).toBe("old-kid");
		expect(t.remainingOnSource).toBe(1);
	});

	it("a key the app replaced while KMS worked is left as the app wrote it, and counted as a conflict", async () => {
		midRun = () => {
			midRun = null;
			store.set("_keys/user/u1.age", new TextEncoder().encode(KEY_TOMBSTONE));
		};
		const t = await run({ dryRun: false });
		expect(t.conflicts).toBe(1);
		expect(new TextDecoder().decode(store.get("_keys/user/u1.age"))).toBe(KEY_TOMBSTONE);
	});

	it("refuses a target or source kid with no KMS key, or a target that is also a source", async () => {
		await expect(run({ to: "missing" })).rejects.toThrow(/target kid names no KMS key/);
		await expect(run({ from: ["missing"] })).rejects.toThrow(/source kid names no KMS key/);
		await expect(run({ from: ["new-kid"] })).rejects.toThrow(/also a source/);
		await expect(run({ from: [] })).rejects.toThrow(/no source kid/);
	});

	it("the report carries counts only, never a path or an owner id", async () => {
		const out = formatRewrapTotals(await run(), { dryRun: true, from: ["old-kid"], to: "new-kid" });
		expect(out).toContain("DRY RUN");
		expect(out).toContain("still on a source kid     3");
		expect(out).not.toMatch(/u1|g1|_keys|AGE-SECRET/);
	});
});
