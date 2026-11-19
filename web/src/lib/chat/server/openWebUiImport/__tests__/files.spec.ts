/**
 * The Open WebUI file pass, with no database and no bucket. Every write it makes is a call to
 * the upload function it is handed, so these specs read the calls to see what reached Alpha and how.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alphaFileDeps, fileLocator, importedPath, importFiles, sidecarPath, type FileDeps, type FileOwner } from "../files";
import { toFile, type SourceFile } from "../sourceRows";
import { emptyUserReport, reportParity, type ImportReport, type UserReport } from "../report";
import { FIXTURE_FILE_BYTES, FIXTURE_FILES } from "./owuiFixture";

const { uploadCustodialFile, listCustodialFiles } = vi.hoisted(() => ({
	uploadCustodialFile: vi.fn(async () => {}),
	listCustodialFiles: vi.fn(async () => [] as { path: string }[]),
}));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({ uploadCustodialFile, listCustodialFiles }));

const fixtureFiles: SourceFile[] = FIXTURE_FILES.map((f) =>
	toFile({ id: f.id, user_id: f.userId, filename: f.filename, path: f.path, data: f.data && JSON.stringify(f.data), meta: JSON.stringify(f.meta), created_at: f.at })
);

const emptyReport = (sourceId: string): UserReport => ({ ...emptyUserReport(sourceId, `${sourceId}@example.org`), account: "created" });

/** A store that keeps what was uploaded, keyed `<account>:<path>`, and fakes nothing else. */
function memoryDeps(over: Partial<FileDeps> = {}) {
	const stored = new Map<string, Blob>();
	const uploads: { account: string; path: string; type: string }[] = [];
	const deps: FileDeps = {
		readBytes: async (f) => {
			const bytes = FIXTURE_FILE_BYTES[f.path!.split("/").pop()!];
			return bytes ? { ok: true, bytes } : { ok: false, reason: "missing" };
		},
		listStored: async (account) => new Set([...stored.keys()].filter((k) => k.startsWith(`${account}:`)).map((k) => k.slice(account.length + 1))),
		storedPath: (account, path) => `users/${account}/${path}`,
		upload: async (account, path, content) => {
			uploads.push({ account, path, type: content.type });
			stored.set(`${account}:${path}`, content);
		},
		extractText: async () => null,
		...over,
	};
	return { deps, stored, uploads };
}

const OWNERS = new Map<string, FileOwner>([
	["u-alice", "acct-alice"],
	["u-bob", "acct-bob"],
]);

async function run(deps: FileDeps, owners: ReadonlyMap<string, FileOwner> = OWNERS) {
	const reports = new Map<string, UserReport>();
	const reportFor = (id: string) => reports.get(id) ?? reports.set(id, emptyReport(id)).get(id)!;
	await importFiles(fixtureFiles, owners, reportFor, deps);
	return { reports, report: { revision: "x", dryRun: false, users: [...reports.values()] } satisfies ImportReport };
}

describe("Open WebUI file pass", () => {
	it("writes each file only through the upload path it is given, under its owner's account, with a text sidecar holding Open WebUI's extracted text", async () => {
		const { deps, stored, uploads } = memoryDeps();
		const { reports, report } = await run(deps);

		const pdf = importedPath(fixtureFiles[0]);
		expect(pdf).toBe("documents/owui-f1a2b3c40000-potluck-notes.pdf");
		expect(uploads.filter((u) => u.account === "acct-alice").map((u) => u.path)).toEqual([pdf, sidecarPath(pdf), importedPath(fixtureFiles[1])]);
		expect(await stored.get(`acct-alice:${pdf}`)!.text()).toBe("bytes of potluck-notes.pdf");
		expect(await stored.get(`acct-alice:${sidecarPath(pdf)}`)!.text()).toBe("Bring a dish that serves six.");
		// The markdown file is text already: no sidecar beside it.
		expect(stored.has(`acct-alice:${sidecarPath(importedPath(fixtureFiles[1]))}`)).toBe(false);
		expect(reports.get("u-alice")!.files).toMatchObject({ in: 2, imported: 2, unchanged: 0, skipped: [], sidecars: 1 });
		// The image had no text in the source and none could be read: stored, without a sidecar, and said so.
		expect(reports.get("u-bob")!.files).toMatchObject({ in: 1, imported: 1, sidecars: 0 });
		expect(reports.get("u-bob")!.files.sidecarNotes).toHaveLength(1);
		// A file whose owner is not in the source is counted and skipped, not dropped.
		expect(reports.get("u-ghost")!.files.skipped).toEqual([{ id: fixtureFiles[3].id, reason: "the file's user_id matches no user row" }]);
		expect(reportParity(report)).toBe(true);
	});

	it("a rerun uploads nothing for files already stored and counts them unchanged, at parity", async () => {
		const { deps, uploads } = memoryDeps();
		await run(deps);
		const before = uploads.length;
		const { reports, report } = await run(deps);

		expect(uploads.length).toBe(before);
		expect(reports.get("u-alice")!.files).toMatchObject({ in: 2, imported: 0, unchanged: 2 });
		expect(reports.get("u-bob")!.files).toMatchObject({ in: 1, imported: 0, unchanged: 1 });
		expect(reportParity(report)).toBe(true);
	});

	it("a file the upload path refuses (the safety scan) is skipped with that refusal's reason and written nowhere else", async () => {
		const refusal = Object.assign(new Error("no CSAM scanner is configured, so the upload was not scanned"), { name: "CsamScannerUnconfiguredError" });
		const { deps, stored } = memoryDeps({
			upload: async () => {
				throw refusal;
			},
		});
		const { reports, report } = await run(deps);

		expect(stored.size).toBe(0);
		expect(reports.get("u-alice")!.files.imported).toBe(0);
		expect(reports.get("u-alice")!.files.skipped.map((s) => s.reason)).toEqual([
			`refused by the upload path: ${refusal.message}`,
			`refused by the upload path: ${refusal.message}`,
		]);
		expect(reportParity(report)).toBe(true);
	});

	it("after the hourly upload limit, the person's remaining files are skipped with a note that a rerun picks them up", async () => {
		const limited = Object.assign(new Error("too many uploads; retry in 60s"), { name: "UploadRateLimitedError" });
		let calls = 0;
		const { deps } = memoryDeps({
			upload: async () => {
				calls += 1;
				throw limited;
			},
		});
		const { reports } = await run(deps, new Map([["u-alice", "acct-alice"]]));

		expect(calls).toBe(1);
		expect(reports.get("u-alice")!.files.skipped).toHaveLength(2);
		expect(reports.get("u-alice")!.files.skipped.every((s) => /a rerun picks this file up/.test(s.reason))).toBe(true);
	});

	it("a dry run uploads and reads nothing and counts every owned file as one it would import", async () => {
		const readBytes = vi.fn();
		const upload = vi.fn();
		const { deps } = memoryDeps({ readBytes, upload });
		const { reports } = await run(deps, new Map<string, FileOwner>([["u-alice", "dry"], ["u-bob", "dry"]]));

		expect(readBytes).not.toHaveBeenCalled();
		expect(upload).not.toHaveBeenCalled();
		expect(reports.get("u-alice")!.files).toMatchObject({ in: 2, imported: 2 });
	});

	it("with Alpha's own dependencies, a file goes to uploadCustodialFile, the upload path My files uses", async () => {
		uploadCustodialFile.mockClear();
		const deps = alphaFileDeps(async () => ({ ok: true, bytes: new TextEncoder().encode("x") }));
		await run(deps, new Map([["u-alice", "acct-alice"]]));

		const paths = (uploadCustodialFile.mock.calls as unknown as [string, string, Blob][]).map(([account, path]) => `${account}:${path}`);
		expect(paths).toContain(`acct-alice:${importedPath(fixtureFiles[0])}`);
		expect(paths).toContain(`acct-alice:${sidecarPath(importedPath(fixtureFiles[0]))}`);
	});
});

describe("where the bytes are read from", () => {
	let dataDir: string;
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "owui-data-"));
		mkdirSync(join(dataDir, "uploads"));
		for (const [name, bytes] of Object.entries(FIXTURE_FILE_BYTES)) writeFileSync(join(dataDir, "uploads", name), bytes);
		writeFileSync(join(dataDir, "secret"), "outside uploads");
	});
	afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

	it("reads a local upload by its last path segment under DATA_DIR/uploads, whatever directory Open WebUI recorded", async () => {
		const read = await fileLocator({ dataDir, storageProvider: "local" })(fixtureFiles[0]);
		expect(read.ok && new TextDecoder().decode(read.bytes)).toBe("bytes of potluck-notes.pdf");
	});

	it("never reads outside DATA_DIR/uploads, even when the recorded path walks out of it", async () => {
		const read = await fileLocator({ dataDir, storageProvider: "local" })({ ...fixtureFiles[0], path: "/app/backend/data/uploads/../secret" });
		expect(read.ok).toBe(false);
	});

	it("reads an s3:// path from S3 when STORAGE_PROVIDER is s3, bucket and key as recorded", async () => {
		const s3Get = vi.fn(async () => new TextEncoder().encode("from s3"));
		const read = await fileLocator({ dataDir: null, storageProvider: "s3", s3Get })(fixtureFiles[2]);
		expect(s3Get).toHaveBeenCalledWith("owui-fixture-bucket", "uploads/f1a2b3c4-0000-4000-8000-000000000003_table.png");
		expect(read.ok && new TextDecoder().decode(read.bytes)).toBe("from s3");
	});

	it("falls back to the copy in DATA_DIR/uploads when S3 is not configured, and names what to set when that is missing too", async () => {
		const local = await fileLocator({ dataDir, storageProvider: "local" })(fixtureFiles[2]);
		expect(local.ok && new TextDecoder().decode(local.bytes)).toBe("bytes of table.png");
		const none = await fileLocator({ dataDir: null, storageProvider: "local" })(fixtureFiles[2]);
		expect(!none.ok && none.reason).toMatch(/STORAGE_PROVIDER=s3/);
	});
});
