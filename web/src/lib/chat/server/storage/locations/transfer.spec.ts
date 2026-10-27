// The two promises a transfer makes. A move never deletes an original whose copy it has not
// verified, and a write into a person's own bucket is screened (CSAM scan included, failing closed)
// before any byte reaches it. The real hfBucketLocation and screenUpload run; the Hub and the scanner
// are mocked. (CUR-2931)
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted((): Record<string, string> => ({}));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const hub = vi.hoisted(() => ({ uploadFile: vi.fn(), pathsInfo: vi.fn(), deleteFile: vi.fn() }));
vi.mock("@huggingface/hub", async (orig) => {
	const real = await orig<Record<string, unknown>>();
	return {
		...real,
		uploadFile: hub.uploadFile,
		pathsInfo: hub.pathsInfo,
		deleteFile: hub.deleteFile,
		listFiles: vi.fn(async function* () {
			yield* [];
		}),
	};
});
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip: vi.fn(async () => {}),
	clearRateLimitTrip: vi.fn(async () => {}),
	recordCsamMatch: vi.fn(async () => {}),
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop: vi.fn(async () => {}) }));

const scanner = vi.hoisted(() => ({ configured: true, scan: vi.fn() }));
vi.mock("../csamScan", async () => {
	const actual = await vi.importActual<typeof import("../csamScan")>("../csamScan");
	return { ...actual, scanCsamHash: scanner.scan, csamScanConfigured: () => scanner.configured };
});

import { CsamScannerUnconfiguredError, HmaUnreachableError } from "../csamScan";
import { hfBucketLocation } from "./hfBucketLocation";
import { transferFile, TransferRefusedError, TransferVerifyError } from "./transfer";
import type { StorageLocation } from "./types";

// A real 1x1 PNG, so the type sniff calls it an image and it goes to the scanner.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);

/** An in-memory location. `landedSize` overrides what stat reports after a write, to fake a bad copy. */
function memory(id: string, files: Record<string, Blob> = {}, landedSize?: number) {
	const store = new Map(Object.entries(files));
	const deleted: string[] = [];
	const loc: StorageLocation = {
		id,
		kind: id === "alpha" ? "alpha" : "hf-bucket",
		label: id,
		capabilities: () => ({ serverSideCopyWithin: true, maxTransferBytes: 1_000_000, grant: "bucket" }),
		list: async () => [...store].map(([path, b]) => ({ path, size: b.size })),
		stat: async (p) => {
			const b = store.get(p);
			if (!b) return null;
			return { size: landedSize !== undefined && p.startsWith(`${id}/`) ? landedSize : b.size };
		},
		read: async (p) => store.get(p) ?? null,
		write: async (folder, name, content) => {
			const p = `${id}/${folder}/${name}`;
			store.set(p, content);
			return p;
		},
		delete: async (p) => {
			deleted.push(p);
			store.delete(p);
		},
	};
	return { loc, store, deleted };
}

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.HF_BUCKETS_TOKEN = "hf_test_token";
	cfg.HF_BUCKETS_REPO = "buckets/example/custodial";
	scanner.configured = true;
	scanner.scan.mockReset().mockResolvedValue({ status: "clean" });
	hub.uploadFile.mockReset().mockResolvedValue(undefined);
	hub.pathsInfo.mockReset();
	hub.deleteFile.mockReset();
});

describe("a move keeps the original unless the copy is verified", () => {
	it("keeps the source (no delete) when the copy's size does not match what was read", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["hello"]) });
		const dst = memory("bucket", {}, 999);
		await expect(transferFile(src.loc, dst.loc, "users/u1/documents/a.txt", "move", {})).rejects.toBeInstanceOf(
			TransferVerifyError
		);
		expect(src.deleted).toEqual([]);
		expect(src.store.has("users/u1/documents/a.txt")).toBe(true);
	});

	it("deletes the source only after a verified copy, and the file is then only at the destination", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["hello"]) });
		const dst = memory("bucket");
		await expect(transferFile(src.loc, dst.loc, "users/u1/documents/a.txt", "move", {})).resolves.toEqual({
			path: "bucket/documents/a.txt",
			outcome: "copied",
		});
		expect(src.store.size).toBe(0);
		expect(dst.store.has("bucket/documents/a.txt")).toBe(true);
	});

	it("into a store that lists sealed sizes, verifies the copy by reading it back rather than by its listed size (CUR-4116)", async () => {
		const src = memory("bucket", { "bucket/documents/a.txt": new Blob(["hello"]) });
		// Alpha storage lists ciphertext, which is larger than what read returns.
		const dst = memory("alpha", {}, 5 + 1_300);
		const sealed: StorageLocation = { ...dst.loc, capabilities: () => ({ ...dst.loc.capabilities(), listsSealedSizes: true }) };
		await expect(transferFile(src.loc, sealed, "bucket/documents/a.txt", "move", {})).resolves.toMatchObject({ outcome: "copied" });
		expect(src.store.size).toBe(0);
	});

	it("a retried move into a store that lists sealed sizes finds the same bytes already there instead of writing a second copy", async () => {
		const src = memory("bucket", { "bucket/documents/a.txt": new Blob(["hello"]) });
		const dst = memory("alpha", { "alpha/documents/a.txt": new Blob(["hello"]) }, 5 + 1_300);
		const sealed: StorageLocation = {
			...dst.loc,
			capabilities: () => ({ ...dst.loc.capabilities(), listsSealedSizes: true }),
			list: async () => [{ path: "alpha/documents/a.txt", size: 5 + 1_300 }],
		};
		await expect(transferFile(src.loc, sealed, "bucket/documents/a.txt", "move", {}, "keepBoth")).resolves.toEqual({
			path: "alpha/documents/a.txt",
			outcome: "alreadyThere",
		});
	});

	it("a copy leaves the source in place", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["hello"]) });
		const dst = memory("bucket");
		await transferFile(src.loc, dst.loc, "users/u1/documents/a.txt", "copy", {});
		expect(src.deleted).toEqual([]);
		expect(dst.store.has("bucket/documents/a.txt")).toBe(true);
	});

	it("a copy whose size does not match fails its check and leaves the source in place (CUR-2941)", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["hello"]) });
		const dst = memory("bucket", {}, 999);
		await expect(transferFile(src.loc, dst.loc, "users/u1/documents/a.txt", "copy", {})).rejects.toBeInstanceOf(
			TransferVerifyError
		);
		expect(src.deleted).toEqual([]);
		expect(src.store.has("users/u1/documents/a.txt")).toBe(true);
	});

	it("refuses (409, writes nothing) when the destination already has a file of that name", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["new"]) });
		const dst = memory("bucket", { "bucket/documents/a.txt": new Blob(["old"]) });
		const err = await transferFile(src.loc, dst.loc, "users/u1/documents/a.txt", "move", {}).catch((e) => e);
		expect(err).toBeInstanceOf(TransferRefusedError);
		expect((err as TransferRefusedError).status).toBe(409);
		expect(await dst.store.get("bucket/documents/a.txt")?.text()).toBe("old");
		expect(src.deleted).toEqual([]);
	});

	it("refuses a transfer to the same location", async () => {
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["x"]) });
		await expect(transferFile(src.loc, src.loc, "users/u1/documents/a.txt", "move", {})).rejects.toBeInstanceOf(
			TransferRefusedError
		);
	});
});

describe("a transfer into a person's own bucket is screened before the write, failing closed", () => {
	const bucket = () =>
		hfBucketLocation({ id: "loc1", label: "mine", userId: "u1", repo: "buckets/me/files", prefix: "", token: "hf_x" });

	it("refuses with HmaUnreachableError and uploads nothing when the CSAM scanner does not answer", async () => {
		scanner.scan.mockRejectedValue(new HmaUnreachableError(new Error("down")));
		const src = memory("alpha", { "users/u1/documents/cat.png": new Blob([PNG]) });
		await expect(
			transferFile(src.loc, bucket(), "users/u1/documents/cat.png", "move", { imagesAllowed: true })
		).rejects.toBeInstanceOf(HmaUnreachableError);
		expect(hub.uploadFile).not.toHaveBeenCalled();
		expect(src.deleted).toEqual([]);
	});

	it("refuses with CsamScannerUnconfiguredError and uploads nothing when no scanner is configured", async () => {
		scanner.configured = false;
		const src = memory("alpha", { "users/u1/documents/a.txt": new Blob(["plain text"]) });
		await expect(transferFile(src.loc, bucket(), "users/u1/documents/a.txt", "copy", {})).rejects.toBeInstanceOf(
			CsamScannerUnconfiguredError
		);
		expect(hub.uploadFile).not.toHaveBeenCalled();
	});
});

describe("moving a batch never stops or overwrites on a name already taken (CUR-2941)", () => {
	// Two chats that each hold shapes.png both land in the bucket's documents/ folder.
	const A = "users/u1/conversations/c1/aaa/shapes.png";
	const B = "users/u1/conversations/c2/bbb/shapes.png";

	it("still refuses a taken name with 409 for a single-file transfer, the default", async () => {
		const src = memory("alpha", { [A]: new Blob(["one"]) });
		const dst = memory("bucket", { "bucket/documents/shapes.png": new Blob(["two"]) });
		const err = await transferFile(src.loc, dst.loc, A, "copy", {}).catch((e) => e);
		expect(err).toBeInstanceOf(TransferRefusedError);
		expect(err.status).toBe(409);
	});

	it("writes different bytes under a taken name as name (2).ext and leaves the file already there untouched", async () => {
		const src = memory("alpha", { [B]: new Blob(["two!"]) });
		const dst = memory("bucket", { "bucket/documents/shapes.png": new Blob(["one"]) });
		const r = await transferFile(src.loc, dst.loc, B, "copy", {}, "keepBoth");
		expect(r).toEqual({ path: "bucket/documents/shapes (2).png", outcome: "renamed" });
		expect(await dst.store.get("bucket/documents/shapes.png")?.text()).toBe("one");
		expect(await dst.store.get("bucket/documents/shapes (2).png")?.text()).toBe("two!");
	});

	it("counts the same bytes already there as copied and writes nothing, under the name or a numbered one", async () => {
		const src = memory("alpha", { [B]: new Blob(["two!"]) });
		const dst = memory("bucket", {
			"bucket/documents/shapes.png": new Blob(["one"]),
			"bucket/documents/shapes (2).png": new Blob(["two!"]),
		});
		const r = await transferFile(src.loc, dst.loc, B, "copy", {}, "keepBoth");
		expect(r).toEqual({ path: "bucket/documents/shapes (2).png", outcome: "alreadyThere" });
		expect([...dst.store.keys()].sort()).toEqual(["bucket/documents/shapes (2).png", "bucket/documents/shapes.png"]);
	});

	it("does not take a same-size file with different bytes for the same file", async () => {
		const src = memory("alpha", { [B]: new Blob(["abc"]) });
		const dst = memory("bucket", { "bucket/documents/shapes.png": new Blob(["xyz"]) });
		const r = await transferFile(src.loc, dst.loc, B, "copy", {}, "keepBoth");
		expect(r.outcome).toBe("renamed");
	});

	it("skips every number already taken and keeps the extension", async () => {
		const src = memory("alpha", { [B]: new Blob(["three"]) });
		const dst = memory("bucket", {
			"bucket/documents/shapes.png": new Blob(["one"]),
			"bucket/documents/shapes (2).png": new Blob(["two!"]),
		});
		const r = await transferFile(src.loc, dst.loc, B, "copy", {}, "keepBoth");
		expect(r).toEqual({ path: "bucket/documents/shapes (3).png", outcome: "renamed" });
	});
});
