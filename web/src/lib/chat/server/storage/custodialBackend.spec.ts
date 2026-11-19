// The backend seam under the custodial store. The local-disk backend runs for real against a
// temporary directory; the S3 backend runs against an in-memory stand-in for the S3 SDK.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cfg = vi.hoisted((): Record<string, string> => ({}));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger }));

// A stand-in for the S3 SDK: an in-memory bucket behind the same commands, so the S3 backend's own
// request shapes, pagination and missing-object handling run, and its client settings can be read back.
const s3 = vi.hoisted(() => ({
	last: null as Record<string, unknown> | null,
	objects: new Map<string, { body: Uint8Array; at: Date }>(),
	pageSize: 2,
}));
vi.mock("@aws-sdk/client-s3", () => {
	class Command {
		constructor(readonly input: { Bucket: string; Key?: string; Body?: Uint8Array }) {}
	}
	class GetObjectCommand extends Command {}
	class PutObjectCommand extends Command {}
	class DeleteObjectCommand extends Command {}
	class HeadObjectCommand extends Command {}
	const missing = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
	class S3Client {
		constructor(options: Record<string, unknown>) {
			s3.last = options;
		}
		async send(cmd: Command) {
			const { Key = "", Body } = cmd.input;
			const o = s3.objects.get(Key);
			if (cmd instanceof PutObjectCommand) return void s3.objects.set(Key, { body: Body!, at: new Date() });
			if (cmd instanceof DeleteObjectCommand) return void s3.objects.delete(Key);
			if (!o) throw missing(cmd instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey");
			if (cmd instanceof HeadObjectCommand) return { ContentLength: o.body.length, LastModified: o.at };
			return { Body: { transformToByteArray: async () => o.body } };
		}
	}
	async function* paginateListObjectsV2(_cfg: unknown, input: { Prefix: string }) {
		const keys = [...s3.objects.keys()].filter((k) => k.startsWith(input.Prefix)).sort();
		for (let i = 0; i < keys.length; i += s3.pageSize) {
			yield {
				Contents: keys.slice(i, i + s3.pageSize).map((Key) => ({ Key, Size: s3.objects.get(Key)!.body.length, LastModified: s3.objects.get(Key)!.at })),
			};
		}
	}
	return { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, paginateListObjectsV2 };
});

// The store's directory sits alone inside its own temporary parent, so a write that escaped it would
// land in the parent, where the traversal test looks.
let parent: string;
let dir: string;

beforeEach(async () => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	logger.error.mockReset();
	s3.last = null;
	s3.objects.clear();
	parent = await mkdtemp(path.join(tmpdir(), "custodial-backend-"));
	dir = path.join(parent, "store");
	await mkdir(dir);
	vi.stubEnv("DEPLOY_ENV", "preview");
	vi.stubEnv("VERCEL_ENV", "");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(parent, { recursive: true, force: true });
});

async function load() {
	return import("./custodialBackend");
}

async function collect(it: AsyncIterable<{ path: string; size: number }>) {
	const out: { path: string; size: number }[] = [];
	for await (const e of it) out.push({ path: e.path, size: e.size });
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

describe("custodialBackend — which store a deployment uses", () => {
	it.each([
		["unset", undefined],
		["empty", ""],
		["blank", "   "],
	])("is a configuration error naming hf, s3 and local, never a fallback to Hugging Face, when CUSTODIAL_STORAGE_BACKEND is %s", async (_label, value) => {
		// Everything the old Hugging Face default needed is present, so only the missing choice can fail it.
		cfg.HF_BUCKETS_REPO = "buckets/acme/files";
		cfg.HF_BUCKETS_TOKEN = "hf_x";
		if (value !== undefined) cfg.CUSTODIAL_STORAGE_BACKEND = value;
		const { custodialBackendConfigured, custodialBackendChosen, custodialBackend } = await load();
		expect(custodialBackendChosen()).toBe(false);
		expect(custodialBackendConfigured()).toBe(false);
		expect(logger.error).toHaveBeenCalledOnce();
		expect(String(logger.error.mock.calls[0][1])).toMatch(/CUSTODIAL_STORAGE_BACKEND is not set.*hf, s3, local/);
		expect(() => custodialBackend()).toThrow(/hf, s3, local/);
	});

	it("is the Hugging Face bucket only when CUSTODIAL_STORAGE_BACKEND is hf, needing its repo and token", async () => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		cfg.HF_BUCKETS_REPO = "buckets/acme/files";
		const { custodialBackendConfigured, custodialBackendChosen, custodialBackend } = await load();
		expect(custodialBackendChosen()).toBe(true);
		expect(custodialBackendConfigured(), "no HF_BUCKETS_TOKEN, so nothing can be read").toBe(false);
		cfg.HF_BUCKETS_TOKEN = "hf_x";
		expect(custodialBackendConfigured()).toBe(true);
		expect((await custodialBackend()).kind).toBe("hf-bucket");
	});

	it("refuses by name (CustodialBucketUnsetError) off production with hf chosen and no HF_BUCKETS_REPO", async () => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
		cfg.HF_BUCKETS_TOKEN = "hf_x";
		const { custodialBackendConfigured, custodialBackend } = await load();
		expect(custodialBackendConfigured()).toBe(false);
		expect(() => custodialBackend()).toThrow(expect.objectContaining({ name: "CustodialBucketUnsetError" }));
	});

	it.each([
		["an unknown backend", { CUSTODIAL_STORAGE_BACKEND: "dropbox" }, /must be one of/],
		["s3 with no bucket", { CUSTODIAL_STORAGE_BACKEND: "s3" }, /CUSTODIAL_S3_BUCKET is not set/],
		["local with no directory", { CUSTODIAL_STORAGE_BACKEND: "local" }, /CUSTODIAL_LOCAL_DIR is not set/],
		["local with a relative directory", { CUSTODIAL_STORAGE_BACKEND: "local", CUSTODIAL_LOCAL_DIR: "data/files" }, /absolute path/],
	])("is unavailable, loudly and once, for %s", async (_label, settings, reason) => {
		Object.assign(cfg, settings);
		const { custodialBackendConfigured, custodialBackendChosen, custodialBackend } = await load();
		expect(custodialBackendConfigured()).toBe(false);
		expect(custodialBackendChosen()).toBe(false);
		expect(logger.error).toHaveBeenCalledOnce();
		expect(String(logger.error.mock.calls[0][1])).toMatch(reason);
		expect(() => custodialBackend()).toThrow(reason);
	});
});

describe("custodialBackend — the local-disk backend keeps each object at its path under the directory", () => {
	beforeEach(() => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "local";
		cfg.CUSTODIAL_LOCAL_DIR = dir;
	});

	it("writes, reads, lists, stats and deletes, and the bytes on disk are exactly the ones written", async () => {
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		expect(store.kind).toBe("local");
		await store.put("users/abc/documents/a.txt", new Blob(["sealed-a"]));
		await store.put("users/abc/conversations/c1/b.bin", new Blob([new Uint8Array([0, 1, 2])]));
		await store.put("users/other/documents/x.txt", new Blob(["x"]));

		expect(await readFile(path.join(dir, "users/abc/documents/a.txt"), "utf8")).toBe("sealed-a");
		expect(await (await store.get("users/abc/documents/a.txt"))?.text()).toBe("sealed-a");
		expect(await collect(store.list("users/abc/"))).toEqual([
			{ path: "users/abc/conversations/c1/b.bin", size: 3 },
			{ path: "users/abc/documents/a.txt", size: 8 },
		]);
		const stat = await store.stat("users/abc/documents/a.txt");
		expect(stat?.size).toBe(8);
		expect(Number.isNaN(Date.parse(stat!.uploadedAt!))).toBe(false);

		await store.delete("users/abc/documents/a.txt");
		expect(await store.get("users/abc/documents/a.txt")).toBeNull();
		expect(await collect(store.list("users/abc/"))).toEqual([{ path: "users/abc/conversations/c1/b.bin", size: 3 }]);
	});

	it("answers a missing object or prefix with null and an empty listing, the contract the Hub SDK had", async () => {
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		expect(await store.get("users/nobody/documents/none.txt")).toBeNull();
		expect(await store.stat("users/nobody/documents/none.txt")).toBeNull();
		expect(await collect(store.list("users/nobody/"))).toEqual([]);
		await expect(store.delete("users/nobody/documents/none.txt")).resolves.toBeUndefined();
	});

	it("keeps a file name with spaces, accents, brackets and other punctuation intact", async () => {
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		const name = "users/abc/documents/Résumé (final) — v2, José's copy+notes@2026.pdf";
		await store.put(name, new Blob(["r"]));
		expect(await (await store.get(name))?.text()).toBe("r");
		expect((await collect(store.list("users/abc/"))).map((e) => e.path)).toEqual([name]);
	});

	it.each(["../escape.txt", "users/abc/../../escape.txt", "/etc/passwd", "users/abc/./a.txt", "users\\abc\\a.txt", "users/abc/a\u0000.txt"])(
		"refuses %j before touching the disk, so no write lands outside the directory",
		async (bad) => {
			const { custodialBackend } = await load();
			const store = await custodialBackend();
			await expect(store.put(bad, new Blob(["x"]))).rejects.toThrow(/refused object path/);
			await expect(store.get(bad)).rejects.toThrow(/refused object path/);
			expect(await readdir(dir)).toEqual([]);
			expect(await readdir(parent)).toEqual(["store"]);
		}
	);
});

describe("custodialBackend — the S3-compatible backend", () => {
	beforeEach(() => {
		cfg.CUSTODIAL_STORAGE_BACKEND = "s3";
		cfg.CUSTODIAL_S3_BUCKET = "alpha-files";
	});

	it("addresses an S3-compatible server by path, in the configured region, with credentials left to the SDK's chain", async () => {
		cfg.CUSTODIAL_S3_ENDPOINT = "http://127.0.0.1:9000";
		cfg.CUSTODIAL_S3_REGION = "us-east-1";
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		expect(store.kind).toBe("s3");
		expect(s3.last).toMatchObject({ endpoint: "http://127.0.0.1:9000", region: "us-east-1", forcePathStyle: true });
		expect(s3.last, "credentials come from the SDK's default chain, never from our config").not.toHaveProperty("credentials");
	});

	it("addresses AWS S3 by host when no endpoint is set, unless path style is asked for", async () => {
		const { custodialBackend } = await load();
		await custodialBackend();
		expect(s3.last).toMatchObject({ endpoint: undefined, forcePathStyle: false });
		cfg.CUSTODIAL_S3_FORCE_PATH_STYLE = "true";
		await custodialBackend();
		expect(s3.last).toMatchObject({ forcePathStyle: true });
	});

	it("writes, reads, lists across pages, stats and deletes, and answers a missing object with null", async () => {
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		const names = ["a.txt", "b.txt", "Résumé (final) — José's copy+notes@2026.pdf"];
		for (const n of names) await store.put(`users/abc/documents/${n}`, new Blob([n]));
		await store.put("users/other/documents/x.txt", new Blob(["x"]));
		expect((await collect(store.list("users/abc/"))).map((e) => e.path)).toEqual(names.map((n) => `users/abc/documents/${n}`).sort((a, b) => a.localeCompare(b)));
		expect(await (await store.get(`users/abc/documents/${names[2]}`))?.text()).toBe(names[2]);
		expect((await store.stat("users/abc/documents/a.txt"))?.size).toBe(5);
		await store.delete("users/abc/documents/a.txt");
		expect(await store.get("users/abc/documents/a.txt")).toBeNull();
		expect(await store.stat("users/abc/documents/a.txt")).toBeNull();
	});

	it("lists the whole bucket for an empty prefix, which is how the backup job reads it", async () => {
		const { custodialBackend } = await load();
		const store = await custodialBackend();
		for (const key of ["_keys/user/u1.recipient", "users/u1/documents/a.age", "users/u2/documents/b.age"]) await store.put(key, new Blob([key]));
		expect((await collect(store.list(""))).map((e) => e.path)).toEqual(["_keys/user/u1.recipient", "users/u1/documents/a.age", "users/u2/documents/b.age"]);
	});

	it("builds the S3 client once per setting, and again when the setting changes", async () => {
		const { custodialBackend } = await load();
		const first = await custodialBackend();
		expect(await custodialBackend()).toBe(first);
		cfg.CUSTODIAL_S3_BUCKET = "other-bucket";
		expect(await custodialBackend()).not.toBe(first);
	});
});
