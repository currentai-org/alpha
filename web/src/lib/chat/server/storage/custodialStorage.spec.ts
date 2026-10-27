// This module is what makes assertOwnership live-reachable (CUR-899), so these tests focus on the
// ownership boundary actually holding, not just the happy path. @huggingface/hub is mocked;
// custodialBucket.ts's real path/ownership logic is not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Real PDFs (CUR-987): a PDF is now opened and its pictures scanned, so a stub byte string named
 *  .pdf is refused as unreadable. Synthetic files from fixtures/embedded-images. */
const pdfFixture = (name: string) =>
	new Blob([readFileSync(fileURLToPath(new URL(`../fixtures/embedded-images/${name}`, import.meta.url)))]);

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const listFiles = vi.fn();
const uploadFile = vi.fn();
const downloadFile = vi.fn();
const deleteFile = vi.fn();
vi.mock("@huggingface/hub", async (importOriginal) => ({
	HubApiError: (await importOriginal<typeof import("@huggingface/hub")>()).HubApiError,
	listFiles,
	uploadFile,
	downloadFile,
	deleteFile,
}));

// Mocked here (not the real DB-backed module) so these tests assert the call site, matching
// alerting.spec.ts's own thorough coverage of recordRateLimitTrip's actual fire/debounce logic rather
// than duplicating it — same posture as rateLimit.spec.ts for CUR-1134. (CUR-1135)
const { recordRateLimitTrip, clearRateLimitTrip, recordCsamMatch } = vi.hoisted(() => ({
	recordRateLimitTrip: vi.fn((_key: string, _opts: { limitName: string; identity: string }) => Promise.resolve()),
	// Same posture as recordRateLimitTrip above — asserts the call site, not
	// clearRateLimitTrip's own decay logic, which alerting.spec.ts covers directly. (CUR-1318)
	clearRateLimitTrip: vi.fn((_key: string) => Promise.resolve()),
	// Same posture again — asserts the call site, not recordCsamMatch's own alert formatting. (CUR-1136)
	recordCsamMatch: vi.fn((_identity: string, _details: unknown) => Promise.resolve()),
}));
// The wipe destroys the owner's key under the Postgres advisory lock (CUR-4117); this spec has no
// database, and advisoryLock.spec.ts covers the lock itself.
vi.mock("$lib/chat/server/db/advisoryLock", () => ({ withAdvisoryLock: <T>(_name: string, fn: () => Promise<T>) => fn() }));
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip,
	clearRateLimitTrip,
	recordCsamMatch,
}));
const { reportCsamMatchToCoop, reportHitToCoop } = vi.hoisted(() => ({
	reportCsamMatchToCoop: vi.fn((_input: unknown) => Promise.resolve()),
	reportHitToCoop: vi.fn((_input: unknown) => Promise.resolve()),
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop, reportHitToCoop }));

// The Shieldstral child-safety screen, stubbed so these tests assert the call site and what
// a refusal does to storage. uploadImageGuard.spec.ts covers the screen itself. The error classes stay
// real, because custodialStorage branches on `instanceof`. (CUR-3201)
const { screenStoredImages } = vi.hoisted(() => ({
	screenStoredImages: vi.fn((_images: Uint8Array[]) => Promise.resolve()),
}));
vi.mock("./uploadImageGuard", async () => {
	const actual = await vi.importActual<typeof import("./uploadImageGuard")>("./uploadImageGuard");
	return { ...actual, screenStoredImages };
});

// scanCsamHash is mocked per-test to control skipped/clean/match/unreachable without a real
// HMA instance; HmaUnreachableError stays the REAL class (vi.importActual) because these tests assert
// `instanceof` against it. (CUR-1136)
const scanCsamHash = vi.fn();
const scanner = { configured: true };
vi.mock("./csamScan", async () => {
	const actual = await vi.importActual<typeof import("./csamScan")>("./csamScan");
	return { ...actual, scanCsamHash, csamScanConfigured: () => scanner.configured };
});
// A real 1x1 PNG, so resolveUploadKind sniffs it as an image and it is sent to the scanner.
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64"
);

const ME = "abc123UserId";
const OTHER = "zzz999OtherUser";
const REPO = "buckets/current-ai-official/custodial-storage-eu";

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
	for (const item of items) yield item;
}

beforeEach(() => {
	// The module keeps each owner's quota listing for a minute, so each test imports it fresh. (CUR-3682)
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.HF_BUCKETS_TOKEN = "hf_test_token";
	// Named explicitly: an unset bucket is refused off production (CUR-4114), tested on its own below.
	cfg.HF_BUCKETS_REPO = REPO;
	listFiles.mockReset();
	uploadFile.mockReset();
	downloadFile.mockReset();
	deleteFile.mockReset();
	recordRateLimitTrip.mockReset().mockResolvedValue(undefined);
	clearRateLimitTrip.mockReset().mockResolvedValue(undefined);
	recordCsamMatch.mockReset().mockResolvedValue(undefined);
	reportCsamMatchToCoop.mockReset().mockResolvedValue(undefined);
	reportHitToCoop.mockReset().mockResolvedValue(undefined);
	screenStoredImages.mockReset().mockResolvedValue(undefined);
	// Default every test to a configured scanner that finds nothing, so only the CSAM describe block
	// below needs to override it.
	scanner.configured = true;
	scanCsamHash.mockReset().mockResolvedValue({ status: "clean" });
});

describe("bucketAccessToken — fails loud, not open", () => {
	it("throws before any hub call when HF_BUCKETS_TOKEN is unset", async () => {
		delete cfg.HF_BUCKETS_TOKEN;
		const { listCustodialFiles } = await import("./custodialStorage");
		await expect(listCustodialFiles(ME)).rejects.toThrow(/HF_BUCKETS_TOKEN/);
		expect(listFiles).not.toHaveBeenCalled();
	});
});

// Preview holds its files in its own bucket under its own token, so the bucket is config. (CUR-1288)
describe("custodialBucketRepo — the configured bucket, or production's, never a guess", () => {
	it("uses production's bucket when HF_BUCKETS_REPO is unset on a production deployment", async () => {
		delete cfg.HF_BUCKETS_REPO;
		vi.stubEnv("DEPLOY_ENV", "production");
		downloadFile.mockResolvedValue(new Blob(["x"]));
		const { downloadCustodialFile } = await import("./custodialStorage");
		await downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO }));
		vi.unstubAllEnvs();
	});

	// A deployment with no HF_BUCKETS_REPO must not read production's bucket. Only production
	// may fall back; every other deployment, and one that declares no environment, refuses by name. (CUR-4114)
	it.each([
		["a preview", "preview"],
		["a development", "development"],
		["an undeclared", ""],
	])(
		"refuses storage with CustodialBucketUnsetError, before any hub call, when HF_BUCKETS_REPO is unset on %s deployment",
		async (_label, env) => {
			delete cfg.HF_BUCKETS_REPO;
			vi.stubEnv("DEPLOY_ENV", env);
			vi.stubEnv("VERCEL_ENV", "");
			downloadFile.mockResolvedValue(new Blob(["x"]));
			listFiles.mockReturnValue(asyncGen([]));
			const { downloadCustodialFile, listCustodialFiles } = await import("./custodialStorage");
			await expect(downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`)).rejects.toMatchObject({ name: "CustodialBucketUnsetError" });
			await expect(listCustodialFiles(ME)).rejects.toThrow(/HF_BUCKETS_REPO is not set/);
			expect(downloadFile).not.toHaveBeenCalled();
			expect(listFiles).not.toHaveBeenCalled();
			vi.unstubAllEnvs();
		}
	);

	it("sends every hub call to the configured bucket, not production's, when HF_BUCKETS_REPO is set", async () => {
		cfg.HF_BUCKETS_REPO = "buckets/current-ai-official/custodial-storage-preview";
		downloadFile.mockResolvedValue(new Blob(["x"]));
		listFiles.mockReturnValue(asyncGen([]));
		const { downloadCustodialFile, deleteCustodialFile, listCustodialFiles } = await import("./custodialStorage");
		await downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		await deleteCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		await listCustodialFiles(ME);

		for (const call of [downloadFile, deleteFile, listFiles]) {
			expect(call).toHaveBeenCalledWith(
				expect.objectContaining({ repo: "buckets/current-ai-official/custodial-storage-preview" })
			);
			expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ repo: REPO }));
		}
	});

	it.each([
		"current-ai-official/custodial-storage",
		"buckets/current-ai-official",
		"https://huggingface.co/buckets/a/b",
	])(
		"throws before any hub call on a malformed HF_BUCKETS_REPO (%s) instead of falling back to production's",
		async (value) => {
			cfg.HF_BUCKETS_REPO = value;
			const { downloadCustodialFile } = await import("./custodialStorage");
			await expect(downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`)).rejects.toThrow(/HF_BUCKETS_REPO/);
			expect(downloadFile).not.toHaveBeenCalled();
		}
	);
});

describe("listCustodialFiles", () => {
	it("scopes the query to the caller's own users/<id>/ prefix and drops directory entries", async () => {
		listFiles.mockReturnValue(
			asyncGen([
				{ type: "file", path: `users/${ME}/documents/a.pdf`, size: 1, uploadedAt: "t" },
				{ type: "directory", path: `users/${ME}/documents`, uploadedAt: "t" },
			])
		);
		const { listCustodialFiles } = await import("./custodialStorage");
		const result = await listCustodialFiles(ME);

		expect(listFiles).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: REPO,
				path: `users/${ME}/`,
				recursive: true,
				accessToken: "hf_test_token",
			})
		);
		expect(result).toEqual([{ type: "file", path: `users/${ME}/documents/a.pdf`, size: 1, uploadedAt: "t" }]);
	});

	it("throws rather than return an entry belonging to a different user, even if the underlying query somehow scoped wrong (CUR-928 is what this actually depends on)", async () => {
		listFiles.mockReturnValue(
			asyncGen([{ type: "file", path: `users/${OTHER}/documents/a.pdf`, size: 1, uploadedAt: "t" }])
		);
		const { listCustodialFiles } = await import("./custodialStorage");
		await expect(listCustodialFiles(ME)).rejects.toThrow(/does not own/);
	});

	it("rejects a malformed user id before ever calling listFiles", async () => {
		const { listCustodialFiles } = await import("./custodialStorage");
		await expect(listCustodialFiles("../escape")).rejects.toThrow(/not a valid custodial-storage user id/);
		expect(listFiles).not.toHaveBeenCalled();
	});
});

describe("uploadCustodialFile", () => {
	it("resolves the path under the caller's own folder and uploads there", async () => {
		// The upload path now lists the caller's files to measure the quota before writing. (CUR-1129)
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		const blob = pdfFixture("text-only.pdf");
		await uploadCustodialFile(ME, "documents/report.pdf", blob);

		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: REPO,
				file: { path: `users/${ME}/documents/report.pdf`, content: blob },
				accessToken: "hf_test_token",
			})
		);
	});

	it("rejects a traversal attempt before ever calling uploadFile", async () => {
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, `../${OTHER}/documents/tax.pdf`, new Blob(["x"]))).rejects.toThrow(
			/resolves outside/
		);
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

// Listing the owner's whole tree to measure the quota on every upload would spend a call on
// the shared storage token each time. A listing is reused for a minute, kept current with this
// instance's own writes and deletes, and a refusal is always made on a fresh one. (CUR-3682)
describe("upload quota — reuses a recent listing instead of listing on every upload (CUR-3682)", () => {
	const stored = (rel: string, size: number) => ({ type: "file", path: `users/${ME}/${rel}`, size, uploadedAt: "t" });

	const many = (n: number) => Array.from({ length: n }, (_, i) => stored(`documents/f${i}.txt`, 1));

	it("a second upload within the minute lists nothing, and counts the first upload toward the cap", async () => {
		const { CUSTODIAL_MAX_FILES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		const before = many(CUSTODIAL_MAX_FILES_PER_USER - 2);
		listFiles.mockImplementation(() => asyncGen(before));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/a.txt", new Blob(["first"]));
		await uploadCustodialFile(ME, "documents/b.txt", new Blob(["second"]));
		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(uploadFile).toHaveBeenCalledTimes(2);

		// Both uploads are in the reused listing, so the owner is at the cap: the third is refused, and only
		// after a fresh listing agrees.
		listFiles.mockImplementation(() => asyncGen([...before, stored("documents/a.txt", 5), stored("documents/b.txt", 6)]));
		await expect(uploadCustodialFile(ME, "documents/c.txt", new Blob(["third"]))).rejects.toThrow(/quota exceeded/);
		expect(listFiles).toHaveBeenCalledTimes(2);
		expect(uploadFile).toHaveBeenCalledTimes(2);
	});

	it("refuses only on a fresh listing, so a file deleted elsewhere frees its place before saying no", async () => {
		const { CUSTODIAL_MAX_FILES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockImplementationOnce(() => asyncGen(many(CUSTODIAL_MAX_FILES_PER_USER - 1)));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/a.txt", new Blob(["ab"]));
		// Another instance deleted the rest; this one's listing still holds them.
		listFiles.mockImplementation(() => asyncGen([stored("documents/a.txt", 2)]));
		await uploadCustodialFile(ME, "documents/b.txt", new Blob(["cd"]));
		expect(listFiles).toHaveBeenCalledTimes(2);
		expect(uploadFile).toHaveBeenCalledTimes(2);
	});

	it("writes an attachment the kept listing still shows once a fresh listing says it is gone", async () => {
		const path = "conversations/c1/s/a.txt";
		listFiles.mockImplementationOnce(() => asyncGen([]));
		const { uploadCustodialFile, storeChatAttachment } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/x.txt", new Blob(["x"]));
		listFiles.mockImplementationOnce(() => asyncGen([]));
		await storeChatAttachment({ userId: ME }, path, new Blob(["a"]));
		// The kept listing now holds the attachment; another instance has since deleted it.
		listFiles.mockImplementation(() => asyncGen([]));
		await storeChatAttachment({ userId: ME }, path, new Blob(["a"]));
		expect(uploadFile).toHaveBeenCalledTimes(3);
	});

	it("lists again after this instance deletes one of the owner's files", async () => {
		listFiles.mockImplementation(() => asyncGen([]));
		const { uploadCustodialFile, deleteCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/a.txt", new Blob(["x"]));
		await deleteCustodialFile(ME, `users/${ME}/documents/a.txt`);
		await uploadCustodialFile(ME, "documents/b.txt", new Blob(["y"]));
		expect(listFiles).toHaveBeenCalledTimes(2);
	});

	it("lists again once the minute is up", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			listFiles.mockImplementation(() => asyncGen([]));
			const { uploadCustodialFile } = await import("./custodialStorage");
			await uploadCustodialFile(ME, "documents/a.txt", new Blob(["x"]));
			vi.setSystemTime(Date.now() + 61_000);
			await uploadCustodialFile(ME, "documents/b.txt", new Blob(["y"]));
			expect(listFiles).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

// PDQ hash-match prewiring. scanCsamHash itself is mocked (see top of file) — these tests
// cover uploadCustodialFile's reaction to each CsamScanResult, not HMA's own hashing/matching, which
// csamScan.spec.ts and a live probe against web/hma/ cover separately. (CUR-1136)
describe("uploadCustodialFile — CSAM scan (CUR-1136, fail closed per CUR-2382)", () => {
	it("refuses an image from an account the multimodal flag does not select, before scanning or storing it (CUR-2725)", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile, ImageInputNotAllowedError } = await import("./custodialStorage");
		// Named like a text file: the refusal reads the bytes, so a renamed image is still refused.
		await expect(
			uploadCustodialFile(ME, "notes/cat.txt", new Blob([PNG_BYTES]), { imagesAllowed: false })
		).rejects.toBeInstanceOf(ImageInputNotAllowedError);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("still stores a non-image for that account, and an image when the flag selects it (CUR-2725)", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("text-only.pdf"), { imagesAllowed: false });
		listFiles.mockReturnValue(asyncGen([]));
		await uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]), { imagesAllowed: true });
		expect(uploadFile).toHaveBeenCalledTimes(2);
	});

	it("refuses every file, even a text one, and writes nothing when no scanner is configured (CUR-2382 fail closed)", async () => {
		scanner.configured = false;
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		const { CsamScannerUnconfiguredError } = await import("./csamScan");
		await expect(uploadCustodialFile(ME, "notes/todo.txt", new Blob(["x"]))).rejects.toBeInstanceOf(
			CsamScannerUnconfiguredError
		);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(scanCsamHash).not.toHaveBeenCalled();
	});

	it("sends a photo to the scanner, and a PDF by each picture inside it, never skipping one (CUR-987)", async () => {
		scanCsamHash.mockResolvedValue({ status: "clean" });
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/notes.pdf", pdfFixture("text-only.pdf"));
		expect(scanCsamHash).not.toHaveBeenCalled();
		listFiles.mockReturnValue(asyncGen([]));
		await uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("xobject.pdf"));
		expect(scanCsamHash).toHaveBeenCalledTimes(1);
		expect(scanCsamHash).toHaveBeenLastCalledWith(expect.any(Blob), "documents/report.pdf#1.png");
		vi.mocked(scanCsamHash).mockClear();
		listFiles.mockReturnValue(asyncGen([]));
		await uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]));
		expect(scanCsamHash).toHaveBeenCalledTimes(1);
		expect(uploadFile).toHaveBeenCalledTimes(3);
	});

	it("refuses an iPhone HEIC as an unsupported type, never as a scanner outage, without calling the scanner or writing (CUR-4665)", async () => {
		// The scanner answers HTTP 500 to these bytes, which read as "try again in a minute" forever.
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile, UnsupportedFileTypeError } = await import("./custodialStorage");
		const upload = uploadCustodialFile(ME, "documents/IMG_0001.HEIC", pdfFixture("photo.heic"), { imagesAllowed: true });
		await expect(upload).rejects.toBeInstanceOf(UnsupportedFileTypeError);
		await expect(upload).rejects.toThrow("image/heic");
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses a PDF unopened for an account document-attachments does not select, and writes nothing (CUR-987)", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile, DocumentInputNotAllowedError } = await import("./custodialStorage");
		await expect(
			uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("xobject.pdf"), { documentsAllowed: false })
		).rejects.toBeInstanceOf(DocumentInputNotAllowedError);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses a PDF whose picture cannot be decoded, and writes nothing (CUR-987, fail closed)", async () => {
		scanCsamHash.mockResolvedValue({ status: "clean" });
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		const { UnscannableFileError } = await import("./embeddedImageScan");
		await expect(
			uploadCustodialFile(ME, "documents/scan.pdf", pdfFixture("jpeg2000.pdf"))
		).rejects.toBeInstanceOf(UnscannableFileError);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("clean: uploads to the caller's real path", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]));
		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				file: { path: `users/${ME}/photos/cat.png`, content: expect.any(Blob) },
			})
		);
		expect(recordCsamMatch).not.toHaveBeenCalled();
	});

	it("match: redirects the write to quarantine, never the caller's real path, alerts, and rejects the upload", async () => {
		scanCsamHash.mockResolvedValue({
			status: "match",
			bankName: "JUPITER_TEST_BANK",
			bankContentId: 20,
			distance: "0",
		});
		const { uploadCustodialFile, CsamMatchError } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]))).rejects.toBeInstanceOf(
			CsamMatchError
		);

		expect(uploadFile).toHaveBeenCalledTimes(1);
		const written = uploadFile.mock.calls[0][0].file.path as string;
		expect(written).toMatch(new RegExp(`^users/${ME}/quarantine/\\d+-cat\\.png$`));
		expect(written).not.toBe(`users/${ME}/photos/cat.png`);

		expect(recordCsamMatch).toHaveBeenCalledWith(ME, {
			bankName: "JUPITER_TEST_BANK",
			bankContentId: 20,
			distance: "0",
		});
		// Quota is never consulted for a matched upload — the file never reaches the caller's own quota.
		expect(listFiles).not.toHaveBeenCalled();
	});

	it("match: files a Coop report against the quarantined copy, as chat's upload guard does (CUR-2382)", async () => {
		scanCsamHash.mockResolvedValue({
			status: "match",
			bankName: "JUPITER_TEST_BANK",
			bankContentId: 20,
			distance: "0",
		});
		const { uploadCustodialFile, CsamMatchError } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]))).rejects.toBeInstanceOf(
			CsamMatchError
		);
		const quarantined = uploadFile.mock.calls[0][0].file.path as string;
		expect(reportCsamMatchToCoop).toHaveBeenCalledWith({
			reportedItemId: quarantined,
			bankName: "JUPITER_TEST_BANK",
			bankContentId: 20,
			distance: "0",
		});
	});

	it("scanner-down fault: refuses an image as unreachable and writes nothing, without calling HMA (CUR-2382)", async () => {
		const { HmaUnreachableError } = await import("./csamScan");
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(
			uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]), { scannerDown: true })
		).rejects.toBeInstanceOf(HmaUnreachableError);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
		expect(reportCsamMatchToCoop).not.toHaveBeenCalled();
	});

	it("sends a photo to the scanner, and a PDF by each picture inside it, never skipping one (CUR-987)", async () => {
		scanCsamHash.mockResolvedValue({ status: "clean" });
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/notes.pdf", pdfFixture("text-only.pdf"));
		expect(scanCsamHash).not.toHaveBeenCalled();
		listFiles.mockReturnValue(asyncGen([]));
		await uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("xobject.pdf"));
		expect(scanCsamHash).toHaveBeenCalledTimes(1);
		expect(scanCsamHash).toHaveBeenLastCalledWith(expect.any(Blob), "documents/report.pdf#1.png");
		vi.mocked(scanCsamHash).mockClear();
		listFiles.mockReturnValue(asyncGen([]));
		await uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]));
		expect(scanCsamHash).toHaveBeenCalledTimes(1);
		expect(uploadFile).toHaveBeenCalledTimes(3);
	});

	it("HMA unreachable: fails closed — no write to either the real path or quarantine", async () => {
		const { HmaUnreachableError } = await import("./csamScan");
		scanCsamHash.mockRejectedValue(new HmaUnreachableError(new Error("ECONNREFUSED")));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]))).rejects.toBeInstanceOf(
			HmaUnreachableError
		);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(recordCsamMatch).not.toHaveBeenCalled();
	});
});

describe("listCustodialFiles — quarantine exclusion (CUR-1136)", () => {
	it("never returns an entry under the caller's own quarantine/ folder", async () => {
		listFiles.mockReturnValue(
			asyncGen([
				{ type: "file", path: `users/${ME}/documents/a.pdf`, size: 1, uploadedAt: "t" },
				{ type: "file", path: `users/${ME}/quarantine/123-bad.png`, size: 1, uploadedAt: "t" },
			])
		);
		const { listCustodialFiles } = await import("./custodialStorage");
		const result = await listCustodialFiles(ME);
		expect(result).toEqual([{ type: "file", path: `users/${ME}/documents/a.pdf`, size: 1, uploadedAt: "t" }]);
	});
});

// A quarantine path is deterministic and guessable by the very person it's
// meant to stop (their own filename, at an upload time they know) — listing exclusion alone doesn't
// block a direct download/delete call against a guessed or previously-seen quarantine path. (CUR-1136)
describe("downloadCustodialFile / deleteCustodialFile — cannot reach the caller's own quarantine/ (CUR-1136)", () => {
	it("refuses to download the caller's own quarantined path, without calling downloadFile", async () => {
		const { downloadCustodialFile } = await import("./custodialStorage");
		await expect(downloadCustodialFile(ME, `users/${ME}/quarantine/1700000000000-bad.png`)).rejects.toThrow(
			/does not own/
		);
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it("refuses to delete the caller's own quarantined path, without calling deleteFile", async () => {
		const { deleteCustodialFile } = await import("./custodialStorage");
		await expect(deleteCustodialFile(ME, `users/${ME}/quarantine/1700000000000-bad.png`)).rejects.toThrow(
			/does not own/
		);
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

// The same refusal must hold when a `..` segment walks back into quarantine/. The ownership
// check normalizes, so the quarantine check has to as well, or the pair disagree about the path. (CUR-3180)
describe("downloadCustodialFile / deleteCustodialFile — a dot segment cannot walk into quarantine/ (CUR-3180)", () => {
	const WALKED = `users/${ME}/documents/../quarantine/1700000000000-bad.png`;

	it("refuses to download a path that resolves into the caller's quarantine/ through `..`, without calling downloadFile", async () => {
		const { downloadCustodialFile } = await import("./custodialStorage");
		await expect(downloadCustodialFile(ME, WALKED)).rejects.toThrow(/does not own/);
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it("refuses to delete a path that resolves into the caller's quarantine/ through `..`, without calling deleteFile", async () => {
		const { deleteCustodialFile } = await import("./custodialStorage");
		await expect(deleteCustodialFile(ME, WALKED)).rejects.toThrow(/does not own/);
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

// CUR-3180 review: the library refuses every form a URL parser would resolve differently, so a
// caller other than the route gets the same protection. posix.normalize sees none of these.
describe("downloadCustodialFile / deleteCustodialFile — encoded dot segments and backslashes are refused (CUR-3180)", () => {
	const FORMS = [
		`users/${ME}/x/%2e%2e/quarantine/1700000000000-bad.png`,
		`users/${ME}/x/.%2e/quarantine/1700000000000-bad.png`,
		`users/${ME}/x/%2E./quarantine/1700000000000-bad.png`,
		`users/${ME}/documents\\..\\quarantine\\1700000000000-bad.png`,
		`users/${ME}/quarantine\\1700000000000-bad.png`,
		`users/${ME}/x/.\t./quarantine/1700000000000-bad.png`,
		`users/${ME}/x/%2\te%2e/quarantine/1700000000000-bad.png`,
		`users/${ME}/x/.\n./quarantine/1700000000000-bad.png`,
		`users/${ME}/x/.\r./quarantine/1700000000000-bad.png`,
	];

	it.each(FORMS)("refuses to download %s without calling downloadFile", async (p) => {
		const { downloadCustodialFile } = await import("./custodialStorage");
		await expect(downloadCustodialFile(ME, p)).rejects.toThrow(/does not own/);
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it.each(FORMS)("refuses to delete %s without calling deleteFile", async (p) => {
		const { deleteCustodialFile } = await import("./custodialStorage");
		await expect(deleteCustodialFile(ME, p)).rejects.toThrow(/does not own/);
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

describe("downloadCustodialFile / deleteCustodialFile — re-verify ownership of a caller-supplied path", () => {
	it("downloads when the path is the caller's own", async () => {
		downloadFile.mockResolvedValue(new Blob(["content"]));
		const { downloadCustodialFile } = await import("./custodialStorage");
		const result = await downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`);

		expect(downloadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: REPO,
				path: `users/${ME}/documents/a.pdf`,
				accessToken: "hf_test_token",
			})
		);
		expect(result).toBeInstanceOf(Blob);
	});

	it("rejects a download of another user's path before calling downloadFile", async () => {
		const { downloadCustodialFile } = await import("./custodialStorage");
		await expect(downloadCustodialFile(ME, `users/${OTHER}/documents/a.pdf`)).rejects.toThrow(/does not own/);
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it("rejects a delete of another user's path before calling deleteFile", async () => {
		const { deleteCustodialFile } = await import("./custodialStorage");
		await expect(deleteCustodialFile(ME, `users/${OTHER}/documents/a.pdf`)).rejects.toThrow(/does not own/);
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

// The recordings sit at the bucket root beside users/, read with no
// session. The guarantee is that this reader cannot be walked into a person's folder. (CUR-2183)
describe("readJourneyRecording — reads journey-gallery/ and nothing else", () => {
	it("reads a recording under journey-gallery/", async () => {
		downloadFile.mockResolvedValue(new Blob(["webm"]));
		const { readJourneyRecording } = await import("./custodialStorage");
		const result = await readJourneyRecording("journey-gallery/a-sign-in/step.webm");
		expect(downloadFile).toHaveBeenCalledWith(
			expect.objectContaining({ repo: REPO, path: "journey-gallery/a-sign-in/step.webm" })
		);
		expect(result).toBeInstanceOf(Blob);
	});

	it.each([
		`users/${ME}/documents/a.pdf`,
		`journey-gallery/../users/${ME}/documents/a.pdf`,
		"journey-gallery//../users/x.pdf",
		"./journey-gallery/a.webm",
		"journey-gallery",
	])("returns null without touching the bucket for %s", async (filename) => {
		const { readJourneyRecording } = await import("./custodialStorage");
		expect(await readJourneyRecording(filename)).toBeNull();
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it("returns null without touching the bucket when this deployment has none", async () => {
		delete cfg.HF_BUCKETS_TOKEN;
		const { readJourneyRecording } = await import("./custodialStorage");
		expect(await readJourneyRecording("journey-gallery/a.webm")).toBeNull();
		expect(downloadFile).not.toHaveBeenCalled();
	});
});

// The limits. Named for the CONTRACT rather than the behaviour, per this repo's rule —
// "refuses" and "does not reach the bucket" are the guarantees; "returns" would pass forever while
// guaranteeing nothing. Every one of these asserts the hub was NOT called, because a limit that
// rejects after the write has already landed is not a limit. (CUR-1129)
// A guest's attachments live under guests/<sessionId>/, written with the same shared token
// as everyone's files. These hold the line between a guest and every other owner. (CUR-2183)
describe("storeChatAttachment for a guest — writes only under its own guests/<sessionId>/", () => {
	const SID = "a".repeat(64);
	const OTHER_SID = "b".repeat(64);
	const text = (n = 10) => new Blob(["x".repeat(n)], { type: "text/plain" });

	it("writes under guests/<sessionId>/", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { storeChatAttachment } = await import("./custodialStorage");
		await storeChatAttachment({ guestSessionId: SID }, "conversations/c1/sha/a.txt", text());
		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({ file: expect.objectContaining({ path: `guests/${SID}/conversations/c1/sha/a.txt` }) })
		);
	});

	it.each([`../../users/${ME}/documents/a.txt`, `../${OTHER_SID}/a.txt`, "/users/x/a.txt"])(
		"refuses %s without calling the bucket",
		async (relativePath) => {
			const { storeChatAttachment } = await import("./custodialStorage");
			await expect(storeChatAttachment({ guestSessionId: SID }, relativePath, text())).rejects.toThrow(/outside their own folder/);
			expect(uploadFile).not.toHaveBeenCalled();
			expect(listFiles).not.toHaveBeenCalled();
		}
	);

	it("refuses a session id that could be a path", async () => {
		const { storeChatAttachment } = await import("./custodialStorage");
		await expect(storeChatAttachment({ guestSessionId: "../users" }, "a.txt", text())).rejects.toThrow(/not a valid/);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses once the session passes the guest quota, which is smaller than an account's", async () => {
		const { GUEST_MAX_TOTAL_BYTES_PER_SESSION, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } =
			await import("$lib/chat/constants/custodialUpload");
		expect(GUEST_MAX_TOTAL_BYTES_PER_SESSION).toBeLessThan(CUSTODIAL_MAX_TOTAL_BYTES_PER_USER);
		listFiles.mockReturnValue(
			asyncGen([
				{
					type: "file",
					path: `guests/${SID}/conversations/c/s/big.txt`,
					size: GUEST_MAX_TOTAL_BYTES_PER_SESSION,
					uploadedAt: "t",
				},
			])
		);
		const { storeChatAttachment } = await import("./custodialStorage");
		await expect(storeChatAttachment({ guestSessionId: SID }, "conversations/c/s/a.txt", text())).rejects.toThrow(/quota exceeded/);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("fails loud if the listing returns a file outside the session's folder", async () => {
		listFiles.mockReturnValue(
			asyncGen([{ type: "file", path: `users/${ME}/documents/a.pdf`, size: 1, uploadedAt: "t" }])
		);
		const { storeChatAttachment } = await import("./custodialStorage");
		await expect(storeChatAttachment({ guestSessionId: SID }, "conversations/c/s/a.txt", text())).rejects.toThrow(/does not own/);
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

// On sign-in a guest's files move to the account, copy first and delete second. (CUR-2183)
describe("moveGuestFilesToUser — copies to users/<id>/ at the same path, then deletes the guest copy", () => {
	const SID = "c".repeat(64);
	const guestFile = (rel: string) => ({ type: "file", path: `guests/${SID}/${rel}`, size: 5, uploadedAt: "t" });

	it("copies each file to the account at the same relative path before deleting it", async () => {
		listFiles.mockReturnValue(asyncGen([guestFile("conversations/c1/s/a.txt")]));
		downloadFile.mockResolvedValue(new Blob(["hello"]));
		const order: string[] = [];
		uploadFile.mockImplementation(async () => void order.push("upload"));
		deleteFile.mockImplementation(async () => void order.push("delete"));
		const { moveGuestFilesToUser } = await import("./custodialStorage");

		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 1, failed: 0, overQuota: 0 });
		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({ file: expect.objectContaining({ path: `users/${ME}/conversations/c1/s/a.txt` }) })
		);
		expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: `guests/${SID}/conversations/c1/s/a.txt` }));
		expect(order).toEqual(["upload", "delete"]);
	});

	it("keeps the guest copy when the account copy fails", async () => {
		listFiles.mockReturnValue(asyncGen([guestFile("conversations/c1/s/a.txt")]));
		downloadFile.mockResolvedValue(new Blob(["hello"]));
		uploadFile.mockRejectedValue(new Error("bucket down"));
		const { moveGuestFilesToUser } = await import("./custodialStorage");

		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 0, failed: 1, overQuota: 0 });
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("leaves quarantined files under the guest's folder", async () => {
		listFiles.mockReturnValue(asyncGen([guestFile("quarantine/1-x.png")]));
		const { moveGuestFilesToUser } = await import("./custodialStorage");

		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 0, failed: 0, overQuota: 0 });
		expect(uploadFile).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("moves only what fits the account quota, and leaves the rest under the guest's folder", async () => {
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles
			.mockReturnValueOnce(
				asyncGen([guestFile("conversations/c1/s/a.txt"), { ...guestFile("conversations/c1/t/b.txt"), size: 20 }])
			)
			.mockReturnValueOnce(
				asyncGen([{ type: "file", path: `users/${ME}/documents/big.pdf`, size: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER - 10, uploadedAt: "t" }])
			);
		downloadFile.mockResolvedValue(new Blob(["hello"]));
		const { moveGuestFilesToUser } = await import("./custodialStorage");

		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 1, failed: 0, overQuota: 1 });
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(deleteFile).toHaveBeenCalledTimes(1);
		expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: `guests/${SID}/conversations/c1/s/a.txt` }));
		expect(recordRateLimitTrip).toHaveBeenCalledWith(`custodial-storage:quota:${ME}`, expect.anything());
	});

	it("moves nothing into an account already at its file-count cap", async () => {
		const { CUSTODIAL_MAX_FILES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles
			.mockReturnValueOnce(asyncGen([guestFile("conversations/c1/s/a.txt")]))
			.mockReturnValueOnce(
				asyncGen(
					Array.from({ length: CUSTODIAL_MAX_FILES_PER_USER }, (_, i) => ({
						type: "file",
						path: `users/${ME}/documents/${i}.txt`,
						size: 1,
						uploadedAt: "t",
					}))
				)
			);
		const { moveGuestFilesToUser } = await import("./custodialStorage");

		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 0, failed: 0, overQuota: 1 });
		expect(uploadFile).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("never throws, even for a session id that is not one", async () => {
		const { moveGuestFilesToUser } = await import("./custodialStorage");
		expect(await moveGuestFilesToUser("../users", ME)).toEqual({ moved: 0, failed: 1, overQuota: 0 });
		expect(listFiles).not.toHaveBeenCalled();
	});
});

// Each guest file expires 30 days after its own upload, never by conversation activity. (CUR-2183)
describe("sweepExpiredGuestFiles — deletes guest files past retention by their own upload time", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = new Date("2026-10-31T00:00:00Z");
	const SID = "c".repeat(64);
	const entry = (rel: string, uploadedAt?: string, root = `guests/${SID}`) => ({
		type: "file",
		path: `${root}/${rel}`,
		size: 1,
		uploadedAt,
	});

	it("deletes a file uploaded more than 30 days ago and keeps a younger one", async () => {
		listFiles.mockReturnValue(
			asyncGen([
				entry("conversations/c/s/old.txt", "2026-09-30T00:00:00Z"),
				entry("conversations/c/s/new.txt", "2026-10-30T00:00:00Z"),
			])
		);
		const { sweepExpiredGuestFiles } = await import("./custodialStorage");
		expect(await sweepExpiredGuestFiles(30 * DAY, NOW)).toEqual({ deleted: 1, failed: 0, undated: 0 });
		expect(deleteFile).toHaveBeenCalledOnce();
		expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: `guests/${SID}/conversations/c/s/old.txt` }));
	});

	it("never deletes outside guests/, whatever the listing returns", async () => {
		listFiles.mockReturnValue(
			asyncGen([
				entry("documents/a.pdf", "2020-01-01T00:00:00Z", `users/${ME}`),
				entry("../users/x/a.pdf", "2020-01-01T00:00:00Z"),
			])
		);
		const { sweepExpiredGuestFiles } = await import("./custodialStorage");
		expect(await sweepExpiredGuestFiles(30 * DAY, NOW)).toEqual({ deleted: 0, failed: 0, undated: 0 });
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("keeps quarantined files and counts undated ones instead of guessing their age", async () => {
		listFiles.mockReturnValue(
			asyncGen([entry("quarantine/1-x.png", "2020-01-01T00:00:00Z"), entry("conversations/c/s/a.txt")])
		);
		const { sweepExpiredGuestFiles } = await import("./custodialStorage");
		expect(await sweepExpiredGuestFiles(30 * DAY, NOW)).toEqual({ deleted: 0, failed: 0, undated: 1 });
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

describe("upload limits — refuse, and refuse BEFORE the bucket is touched", () => {
	async function upload(bytes: number, name = "a.txt", type = "text/plain") {
		const { uploadCustodialFile } = await import("./custodialStorage");
		return uploadCustodialFile(ME, name, new Blob(["x".repeat(bytes)], { type }));
	}

	it("refuses a file over the per-file byte cap without calling the bucket", async () => {
		const { CUSTODIAL_MAX_BYTES_PER_FILE } = await import("$lib/chat/constants/custodialUpload");
		await expect(upload(CUSTODIAL_MAX_BYTES_PER_FILE + 1)).rejects.toThrow(/file is \d+ bytes/);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(listFiles).not.toHaveBeenCalled();
	});

	it("holds a chunked upload to the ceiling it names, refusing a byte past it before the bucket (CUR-1780)", async () => {
		const { uploadCustodialFile } = await import("./custodialStorage");
		const big = new Blob(["x".repeat(6_000_001)], { type: "text/plain" });
		await expect(uploadCustodialFile(ME, "a.txt", big, { maxBytes: 6_000_000 })).rejects.toThrow(/file is \d+ bytes/);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("lets a chunked upload past the one-request cap when its ceiling allows it (CUR-1780)", async () => {
		const { CUSTODIAL_MAX_BYTES_PER_FILE, CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE } = await import(
			"$lib/chat/constants/custodialUpload"
		);
		const { uploadCustodialFile } = await import("./custodialStorage");
		listFiles.mockReturnValue(asyncGen([]));
		const big = new Blob(["x".repeat(CUSTODIAL_MAX_BYTES_PER_FILE + 1)], { type: "text/plain" });
		await uploadCustodialFile(ME, "a.txt", big, { maxBytes: CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE });
		expect(uploadFile).toHaveBeenCalledOnce();
	});

	it("refuses a type the allowlist does not name, judged from bytes not filename", async () => {
		// Real ELF magic bytes behind a .txt name: the extension says text, the bytes say binary.
		// Trusting the name here is the whole bug class this check exists for.
		const { uploadCustodialFile } = await import("./custodialStorage");
		const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		await expect(uploadCustodialFile(ME, "harmless.txt", new Blob([elf], { type: "text/plain" }))).rejects.toThrow(
			/unsupported file type/
		);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses once the person's stored bytes would pass the quota", async () => {
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockReturnValue(
			asyncGen([
				{
					type: "file",
					path: `users/${ME}/documents/big.pdf`,
					size: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
					uploadedAt: "t",
				},
			])
		);
		await expect(upload(10)).rejects.toThrow(/quota exceeded/);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("measures the quota from the live listing, not a counter — a delete frees room immediately", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		await expect(upload(10)).resolves.toBeUndefined();
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	// A successful upload is proof the caller is CURRENTLY under quota — clear any prior
	// quota trip here, since (unlike the rate-limit callers) nothing about the quota condition
	// itself decays with time. (CUR-1318)
	it("clears a prior quota trip on every successful upload, so a stale trip can't keep re-firing", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		await expect(upload(10)).resolves.toBeUndefined();
		expect(clearRateLimitTrip).toHaveBeenCalledWith(`custodial-storage:quota:${ME}`);
	});

	// Passing the quota check only proves the caller was under quota at
	// read time, not that anything actually resolved — a write that then fails must NOT clear the
	// trip, or a person who keeps failing (never succeeding) would look "recovered". (CUR-1318)
	it("does NOT clear the quota trip when the upload itself fails after passing the quota check", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		uploadFile.mockRejectedValueOnce(new Error("bucket write failed"));
		await expect(upload(10)).rejects.toThrow("bucket write failed");
		expect(clearRateLimitTrip).not.toHaveBeenCalled();
	});

	it("refuses past the hourly upload rate and names when to retry", async () => {
		// The counter is module-level state and every other test in this file shares it, so this one
		// needs its own instance — otherwise it measures whatever the earlier tests happened to spend.
		vi.resetModules();
		const { uploadCustodialFile } = await import("./custodialStorage");
		const upload = (n: number, name: string) =>
			uploadCustodialFile(ME, name, new Blob(["x".repeat(n)], { type: "text/plain" }));
		const { CUSTODIAL_UPLOADS_PER_HOUR } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockReturnValue(asyncGen([]));
		for (let i = 0; i < CUSTODIAL_UPLOADS_PER_HOUR; i++) {
			listFiles.mockReturnValue(asyncGen([]));
			await upload(1, `f${i}.txt`);
		}
		await expect(upload(1, "one-too-many.txt")).rejects.toThrow(/too many uploads; retry in \d+s/);
	});

	it("still refuses a path outside the caller's folder before any limit is consulted", async () => {
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(
			uploadCustodialFile(ME, `../${OTHER}/stolen.txt`, new Blob(["x"], { type: "text/plain" }))
		).rejects.toThrow(/resolves outside their own folder/);
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

describe("quota under concurrency — the race the listing cannot see", () => {
	it("counts in-flight bytes, so two same-process uploads cannot both pass against one listing", async () => {
		vi.resetModules();
		const { uploadCustodialFile, StorageQuotaExceededError } = await import("./custodialStorage");
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		// Near the ceiling with room for ONE more 3 MB file, not two. Each upload is legal alone and
		// illegal together, and both are under the per-file cap so that check can't mask the quota one.
		const stored = CUSTODIAL_MAX_TOTAL_BYTES_PER_USER - 5_000_000;
		listFiles.mockImplementation(() =>
			asyncGen([{ type: "file", path: `users/${ME}/documents/old.pdf`, size: stored, uploadedAt: "t" }])
		);
		const each = 3_000_000;
		let release!: () => void;
		uploadFile.mockImplementation(() => new Promise<void>((r) => (release = () => r())));

		const blob = () => new Blob(["x".repeat(each)], { type: "text/plain" });
		const first = uploadCustodialFile(ME, "a.txt", blob());
		// Let the first reach its write and park there, holding its reservation.
		await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
		const second = uploadCustodialFile(ME, "b.txt", blob());

		await expect(second).rejects.toBeInstanceOf(StorageQuotaExceededError);
		expect(uploadFile).toHaveBeenCalledTimes(1); // the second never reached the bucket
		release();
		await expect(first).resolves.toBeUndefined();
	});

	it("releases the reservation when an upload fails, so a failure doesn't shrink the quota", async () => {
		vi.resetModules();
		const { uploadCustodialFile } = await import("./custodialStorage");
		listFiles.mockImplementation(() => asyncGen([]));
		uploadFile.mockRejectedValueOnce(new Error("hub exploded"));
		await expect(uploadCustodialFile(ME, "a.txt", new Blob(["x"], { type: "text/plain" }))).rejects.toThrow(
			/hub exploded/
		);
		// The next upload must see a clean slate rather than a permanently-reserved byte.
		uploadFile.mockResolvedValueOnce(undefined);
		await expect(uploadCustodialFile(ME, "b.txt", new Blob(["x"], { type: "text/plain" }))).resolves.toBeUndefined();
	});
});

// A bare 4xx (or, for download/delete, silence) must raise an alert — pin
// the call site directly, not just that recordRateLimitTrip itself fires and debounces correctly
// (alerting.spec.ts already covers that in full). (CUR-1135)
describe("CUR-1135 velocity alerting", () => {
	it("alerts AND still throws when the hourly upload rate limit trips", async () => {
		vi.resetModules();
		const { uploadCustodialFile } = await import("./custodialStorage");
		const { CUSTODIAL_UPLOADS_PER_HOUR } = await import("$lib/chat/constants/custodialUpload");
		const upload = (name: string) => uploadCustodialFile(ME, name, new Blob(["x"], { type: "text/plain" }));
		listFiles.mockReturnValue(asyncGen([]));
		for (let i = 0; i < CUSTODIAL_UPLOADS_PER_HOUR; i++) {
			listFiles.mockReturnValue(asyncGen([]));
			await upload(`f${i}.txt`);
		}
		expect(recordRateLimitTrip).not.toHaveBeenCalled(); // not yet — this next one is the trip

		await expect(upload("one-too-many.txt")).rejects.toThrow(/too many uploads/);
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toBe(`custodial-storage:upload-rate:${ME}`);
		expect(recordRateLimitTrip.mock.calls[0][1]).toMatchObject({ identity: ME });
	});

	it("alerts AND still throws when the storage quota is exceeded", async () => {
		vi.resetModules();
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockReturnValue(
			asyncGen([
				{
					type: "file",
					path: `users/${ME}/documents/big.pdf`,
					size: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
					uploadedAt: "t",
				},
			])
		);
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(
			uploadCustodialFile(ME, "one-more.txt", new Blob(["x".repeat(10)], { type: "text/plain" }))
		).rejects.toThrow(/quota exceeded/);
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toBe(`custodial-storage:quota:${ME}`);
	});

	it("does not alert on ordinary upload/download/delete volume", async () => {
		vi.resetModules();
		listFiles.mockReturnValue(asyncGen([]));
		downloadFile.mockResolvedValue(new Blob(["x"]));
		const { uploadCustodialFile, downloadCustodialFile, deleteCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "a.txt", new Blob(["x"], { type: "text/plain" }));
		await downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		await deleteCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		expect(recordRateLimitTrip).not.toHaveBeenCalled();
	});

	it("alerts on download velocity WITHOUT blocking the download — no cap exists for it", async () => {
		vi.resetModules();
		const { downloadCustodialFile, CUSTODIAL_DOWNLOAD_VELOCITY_ALERT_PER_HOUR } = await import("./custodialStorage");
		downloadFile.mockResolvedValue(new Blob(["x"]));
		for (let i = 0; i < CUSTODIAL_DOWNLOAD_VELOCITY_ALERT_PER_HOUR; i++) {
			await expect(downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`)).resolves.toBeInstanceOf(Blob);
		}
		expect(recordRateLimitTrip).not.toHaveBeenCalled(); // not yet — this next one crosses it

		await expect(downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`)).resolves.toBeInstanceOf(Blob); // still succeeds — velocity alerting is not a cap
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toBe(`custodial-storage:download-velocity:${ME}`);
	});

	it("alerts on delete velocity WITHOUT blocking the delete — no cap exists for it", async () => {
		vi.resetModules();
		const { deleteCustodialFile, CUSTODIAL_DELETE_VELOCITY_ALERT_PER_HOUR } = await import("./custodialStorage");
		for (let i = 0; i < CUSTODIAL_DELETE_VELOCITY_ALERT_PER_HOUR; i++) {
			await expect(deleteCustodialFile(ME, `users/${ME}/documents/a.pdf`)).resolves.toBeUndefined();
		}
		expect(recordRateLimitTrip).not.toHaveBeenCalled();

		await expect(deleteCustodialFile(ME, `users/${ME}/documents/a.pdf`)).resolves.toBeUndefined();
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toBe(`custodial-storage:delete-velocity:${ME}`);
	});

	it("keeps upload-rate, quota, download-velocity and delete-velocity as independent debounce keys per user", async () => {
		vi.resetModules();
		const mod = await import("./custodialStorage");
		listFiles.mockReturnValue(asyncGen([]));
		downloadFile.mockResolvedValue(new Blob(["x"]));
		for (let i = 0; i < mod.CUSTODIAL_DOWNLOAD_VELOCITY_ALERT_PER_HOUR + 1; i++) {
			await mod.downloadCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		}
		for (let i = 0; i < mod.CUSTODIAL_DELETE_VELOCITY_ALERT_PER_HOUR + 1; i++) {
			await mod.deleteCustodialFile(ME, `users/${ME}/documents/a.pdf`);
		}
		const keys = recordRateLimitTrip.mock.calls.map((c) => c[0]);
		expect(keys).toContain(`custodial-storage:download-velocity:${ME}`);
		expect(keys).toContain(`custodial-storage:delete-velocity:${ME}`);
		expect(new Set(keys).size).toBe(2); // two distinct patterns, not one shared key
	});
});

describe("wipeCustodialFiles — account deletion reaches the bucket, and fails loud when it cannot", () => {
	const file = (p: string) => ({ type: "file", path: p, size: 1, uploadedAt: "t" });

	it("deletes every file under the caller's own prefix and returns how many", async () => {
		listFiles.mockReturnValue(
			asyncGen([file(`users/${ME}/documents/board-meeting-agenda.txt`), file(`users/${ME}/conversations/c1/notes.md`)])
		);
		deleteFile.mockResolvedValue(undefined);
		const { wipeCustodialFiles } = await import("./custodialStorage");
		await expect(wipeCustodialFiles(ME)).resolves.toBe(2);
		expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, path: `users/${ME}/` }));
		expect(deleteFile.mock.calls.map(([a]) => a.path)).toEqual([
			`users/${ME}/documents/board-meeting-agenda.txt`,
			`users/${ME}/conversations/c1/notes.md`,
		]);
	});

	it("keeps quarantined uploads (CSAM-match evidence) out of the delete", async () => {
		listFiles.mockReturnValue(
			asyncGen([file(`users/${ME}/documents/a.txt`), file(`users/${ME}/quarantine/123-b.png`)])
		);
		deleteFile.mockResolvedValue(undefined);
		const { wipeCustodialFiles } = await import("./custodialStorage");
		await expect(wipeCustodialFiles(ME)).resolves.toBe(1);
		expect(deleteFile.mock.calls.map(([a]) => a.path)).toEqual([`users/${ME}/documents/a.txt`]);
	});

	it("throws CustodialWipeError (never reports success) when any delete fails", async () => {
		listFiles.mockReturnValue(asyncGen([file(`users/${ME}/documents/a.txt`), file(`users/${ME}/documents/b.txt`)]));
		deleteFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("hub 500"));
		const { wipeCustodialFiles, CustodialWipeError } = await import("./custodialStorage");
		const err = await wipeCustodialFiles(ME).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CustodialWipeError);
		expect(err).toMatchObject({ deleted: 1, failed: 1 });
	});

	it("throws CustodialWipeError when the listing itself fails, rather than reporting zero files", async () => {
		listFiles.mockImplementation(() => {
			throw new Error("hub unreachable");
		});
		const { wipeCustodialFiles, CustodialWipeError } = await import("./custodialStorage");
		await expect(wipeCustodialFiles(ME)).rejects.toBeInstanceOf(CustodialWipeError);
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("returns undefined, not zero, when custodial storage is not configured on this deployment", async () => {
		delete cfg.HF_BUCKETS_TOKEN;
		const { wipeCustodialFiles } = await import("./custodialStorage");
		await expect(wipeCustodialFiles(ME)).resolves.toBeUndefined();
		expect(listFiles).not.toHaveBeenCalled();
	});
});

describe("storeChatAttachment — a chat attachment's only copy (CUR-2183)", () => {
	const SHA = "a".repeat(64);
	const rel = `conversations/c1/${SHA}/notes.txt`;
	const pasteRel = `conversations/c1/pastes/${SHA}/Pasted Content`;
	const entry = (relPath: string, size: number) => ({ type: "file", path: `users/${ME}/${relPath}`, size, uploadedAt: "t" });

	it("writes under the owner's conversation folder without scanning again, since the chat turn already did", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { storeChatAttachment } = await import("./custodialStorage");
		await storeChatAttachment({ userId: ME }, rel, new Blob([PNG_BYTES], { type: "image/png" }));
		expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ path: `users/${ME}/${rel}` }) }));
		expect(scanCsamHash).not.toHaveBeenCalled();
	});

	it("refuses with StorageQuotaExceededError when the file does not fit, and writes nothing", async () => {
		const { storeChatAttachment, StorageQuotaExceededError } = await import("./custodialStorage");
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockReturnValue(asyncGen([entry("documents/big.pdf", CUSTODIAL_MAX_TOTAL_BYTES_PER_USER)]));
		await expect(storeChatAttachment({ userId: ME }, rel, new Blob(["hello"]))).rejects.toBeInstanceOf(StorageQuotaExceededError);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("does not write or count again a file already at the path, so resending a full owner's attachment is not refused", async () => {
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles.mockReturnValue(asyncGen([entry(rel, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER)]));
		const { storeChatAttachment } = await import("./custodialStorage");
		await storeChatAttachment({ userId: ME }, rel, new Blob(["hello"]));
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("writes a paste with no quota listing, for an owner whose files are full", async () => {
		const { storeChatAttachment } = await import("./custodialStorage");
		await storeChatAttachment({ userId: ME }, pasteRel, new Blob(["pasted"]));
		expect(listFiles).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ path: `users/${ME}/${pasteRel}` }) }));
	});

	it("keeps pastes out of My files' listing and out of the quota an attachment is measured against", async () => {
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		const paste = entry(pasteRel, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER);
		listFiles.mockImplementation(() => asyncGen([paste, entry("documents/a.pdf", 1)]));
		const { listCustodialFiles, storeChatAttachment } = await import("./custodialStorage");
		expect((await listCustodialFiles(ME)).map((e) => e.path)).toEqual([`users/${ME}/documents/a.pdf`]);
		await storeChatAttachment({ userId: ME }, rel, new Blob(["hello"]));
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	it("account deletion wipes stored pastes too, though My files leaves them out", async () => {
		listFiles.mockImplementation(() => asyncGen([entry(pasteRel, 6), entry("documents/a.pdf", 1)]));
		const { wipeCustodialFiles } = await import("./custodialStorage");
		await expect(wipeCustodialFiles(ME)).resolves.toBe(2);
		expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: `users/${ME}/${pasteRel}` }));
	});

	it("writes a guest's attachment under its session", async () => {
		const SID = "d".repeat(64);
		listFiles.mockReturnValue(asyncGen([]));
		const { storeChatAttachment } = await import("./custodialStorage");
		await storeChatAttachment({ guestSessionId: SID }, rel, new Blob(["hello"]));
		expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ path: `guests/${SID}/${rel}` }) }));
	});

	it("moves a guest's pastes to the account on sign-in, without counting them against its quota", async () => {
		const SID = "c".repeat(64);
		const { CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } = await import("$lib/chat/constants/custodialUpload");
		listFiles
			.mockReturnValueOnce(asyncGen([{ type: "file", path: `guests/${SID}/${pasteRel}`, size: 10, uploadedAt: "t" }]))
			.mockReturnValueOnce(asyncGen([entry("documents/big.pdf", CUSTODIAL_MAX_TOTAL_BYTES_PER_USER)]));
		downloadFile.mockResolvedValue(new Blob(["pasted"]));
		const { moveGuestFilesToUser } = await import("./custodialStorage");
		expect(await moveGuestFilesToUser(SID, ME)).toEqual({ moved: 1, failed: 0, overQuota: 0 });
		expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ path: `users/${ME}/${pasteRel}` }) }));
	});
});

describe("the child-safety screen on stored pictures (CUR-3201)", () => {
	it("refuses a My files image the screen blocks, and stores nothing at the caller's path", async () => {
		const { ImageScreenBlockedError } = await import("./uploadImageGuard");
		const hits = [{ key: "chat-block-child-sexual-content", action: "block" as const, tier: "child" as const }];
		screenStoredImages.mockRejectedValue(new ImageScreenBlockedError("chat-block-child-sexual-content", hits));
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile, CsamMatchError } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]))).rejects.toBeInstanceOf(
			CsamMatchError
		);
		// The only write is the quarantined copy a reviewer can find.
		const paths = uploadFile.mock.calls.map((c) => c[0].file.path as string);
		expect(paths).toHaveLength(1);
		expect(paths[0]).toMatch(new RegExp(`^users/${ME}/quarantine/\\d+-cat\\.png$`));
		expect(reportHitToCoop).toHaveBeenCalledWith(
			expect.objectContaining({ surface: "storage-upload", messageId: paths[0], hits, subjectId: ME })
		);
	});

	it("sends the photo's own bytes to the screen after the hash check passes", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]));
		expect(screenStoredImages).toHaveBeenCalledTimes(1);
		const [pictures] = screenStoredImages.mock.calls[0];
		expect(pictures).toHaveLength(1);
		expect(Buffer.from(pictures[0]).equals(PNG_BYTES)).toBe(true);
	});

	it("sends every picture inside a PDF to the screen, and none for a PDF with no pictures", async () => {
		listFiles.mockReturnValue(asyncGen([]));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("xobject.pdf"));
		expect(screenStoredImages.mock.calls[0][0].length).toBeGreaterThan(0);
		expect(screenStoredImages.mock.calls[0][0]).toHaveLength(scanCsamHash.mock.calls.length);

		screenStoredImages.mockClear();
		await uploadCustodialFile(ME, "documents/notes.pdf", pdfFixture("text-only.pdf"));
		expect(screenStoredImages.mock.calls[0][0]).toHaveLength(0);
	});

	it("refuses a file the screen cannot answer for (fail closed) and writes nothing at all", async () => {
		const { ImageScreenUnavailableError } = await import("./uploadImageGuard");
		screenStoredImages.mockRejectedValue(new ImageScreenUnavailableError("no answer from the screen"));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(uploadCustodialFile(ME, "photos/cat.png", new Blob([PNG_BYTES]))).rejects.toBeInstanceOf(
			ImageScreenUnavailableError
		);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(reportHitToCoop).not.toHaveBeenCalled();
	});

	it("refuses a document with too many pictures to screen and writes nothing at all", async () => {
		const { TooManyImagesToScreenError } = await import("./uploadImageGuard");
		screenStoredImages.mockRejectedValue(new TooManyImagesToScreenError(21));
		const { uploadCustodialFile } = await import("./custodialStorage");
		await expect(
			uploadCustodialFile(ME, "documents/report.pdf", pdfFixture("xobject.pdf"))
		).rejects.toBeInstanceOf(TooManyImagesToScreenError);
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

describe("transientHubError — only a busy or failing Hub earns a retry (CUR-3291)", () => {
	it("retries a 429, a 5xx and a request that never landed, and nothing else", async () => {
		const { HubApiError } = await import("@huggingface/hub");
		const { transientHubError } = await import("./custodialStorage");
		expect(transientHubError(new HubApiError("u", 429))).toBe(true);
		expect(transientHubError(new HubApiError("u", 503))).toBe(true);
		expect(transientHubError(new TypeError("fetch failed"))).toBe(true);
		expect(transientHubError(new HubApiError("u", 403))).toBe(false);
		expect(transientHubError(new HubApiError("u", 404))).toBe(false);
		expect(transientHubError(new Error("UnknownLocationError"))).toBe(false);
	});
});
