/**
 * The Open WebUI file pass through Alpha's real upload path. Only the scanner's network call
 * and the bucket backend are stubbed, so `importFiles` runs `alphaFileDeps` and the real
 * `uploadCustodialFile` (size, type, rate, safety scan, sealed write). files.spec.ts mocks the upload
 * function wholesale, so it cannot say whether an imported file is scanned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FileDeps, FileOwner } from "../files";
import { toFile, type SourceFile } from "../sourceRows";
import { emptyUserReport, type UserReport } from "../report";
import { FIXTURE_FILES } from "./owuiFixture";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const order: string[] = [];
const listFiles = vi.fn();
const uploadFile = vi.fn();
vi.mock("@huggingface/hub", async (importOriginal) => ({
	HubApiError: (await importOriginal<typeof import("@huggingface/hub")>()).HubApiError,
	listFiles,
	uploadFile,
	downloadFile: vi.fn(),
	deleteFile: vi.fn(),
}));

vi.mock("$lib/chat/server/db/advisoryLock", () => ({ withAdvisoryLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
const { recordCsamMatch, reportCsamMatchToCoop } = vi.hoisted(() => ({
	recordCsamMatch: vi.fn(() => Promise.resolve()),
	reportCsamMatchToCoop: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip: vi.fn(() => Promise.resolve()),
	clearRateLimitTrip: vi.fn(() => Promise.resolve()),
	recordCsamMatch,
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop, reportHitToCoop: vi.fn(() => Promise.resolve()) }));
vi.mock("$lib/chat/server/storage/uploadImageGuard", async () => ({
	...(await vi.importActual<typeof import("$lib/chat/server/storage/uploadImageGuard")>("$lib/chat/server/storage/uploadImageGuard")),
	screenStoredImages: vi.fn(() => Promise.resolve()),
}));

// The scanner's network call. CsamScannerUnreachableError and the rest of csamScan stay real.
const scanCsamHash = vi.fn();
vi.mock("$lib/chat/server/storage/csamScan", async () => ({
	...(await vi.importActual<typeof import("$lib/chat/server/storage/csamScan")>("$lib/chat/server/storage/csamScan")),
	scanCsamHash,
	csamScanAllowsUploads: () => true,
	csamScanSkipped: () => false,
}));

const fixtureBytes = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/embedded-images/${name}`, import.meta.url))));
/** Real files, because the upload path sniffs a type from the bytes and opens a PDF to scan its pictures. */
const BYTES: Record<string, Uint8Array> = {
	"potluck-notes.pdf": fixtureBytes("xobject.pdf"),
	"menu.md": new TextEncoder().encode("# Menu"),
	"table.png": fixtureBytes("noise.png"),
};

const files: SourceFile[] = FIXTURE_FILES.map((f) =>
	toFile({ id: f.id, user_id: f.userId, filename: f.filename, path: f.path, data: f.data && JSON.stringify(f.data), meta: JSON.stringify(f.meta), created_at: f.at })
).filter((f) => f.userId !== "u-ghost");

const OWNERS = new Map<string, FileOwner>([
	["u-alice", "acct-alice"],
	["u-bob", "acct-bob"],
]);

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.CUSTODIAL_STORAGE_BACKEND = "hf";
	cfg.HF_BUCKETS_TOKEN = "hf_test_token";
	cfg.HF_BUCKETS_REPO = "buckets/current-ai-official/custodial-storage-eu";
	order.length = 0;
	listFiles.mockReset().mockImplementation(async function* () {});
	uploadFile.mockReset().mockImplementation(async ({ file }: { file: { path: string } }) => {
		order.push(`write ${file.path}`);
	});
	recordCsamMatch.mockClear();
	reportCsamMatchToCoop.mockClear();
	scanCsamHash.mockReset().mockImplementation(async (_blob: Blob, name: string) => {
		order.push(`scan ${name}`);
		return { status: "clean" };
	});
});

/** Alpha's own file deps over the real upload path, reading the fixture rows' bytes from BYTES. */
async function run() {
	const { alphaFileDeps, importFiles } = await import("../files");
	const deps: FileDeps = alphaFileDeps(async (f) => {
		const bytes = BYTES[f.filename];
		return bytes ? { ok: true, bytes } : { ok: false, reason: "missing" };
	});
	const reports = new Map<string, UserReport>();
	const reportFor = (id: string) =>
		reports.get(id) ?? reports.set(id, { ...emptyUserReport(id, `${id}@example.org`), account: "created" }).get(id)!;
	const results = await importFiles(files, OWNERS, reportFor, deps);
	return { results, reportFor };
}

const written = () => uploadFile.mock.calls.map((c) => c[0].file.path as string);
const importedPaths = async () => {
	const { importedPath } = await import("../files");
	return Object.fromEntries(files.map((f) => [f.filename, importedPath(f)]));
};

describe("Open WebUI import through the real upload path", () => {
	it("sends each imported picture-bearing file to the scanner before writing it, and a text file, which has no picture to scan, is still written", async () => {
		await run();
		const p = await importedPaths();
		expect(scanCsamHash).toHaveBeenCalledTimes(2);
		// The PDF is scanned by the picture inside it; the PNG as itself.
		expect(order.indexOf(`scan ${p["potluck-notes.pdf"]}#1.png`)).toBeGreaterThanOrEqual(0);
		expect(order.indexOf(`scan ${p["table.png"]}`)).toBeGreaterThanOrEqual(0);
		for (const [name, owner] of [["potluck-notes.pdf", "acct-alice"], ["table.png", "acct-bob"]] as const) {
			const scanAt = order.findIndex((o) => o.startsWith(`scan ${p[name]}`));
			const writeAt = order.indexOf(`write users/${owner}/${p[name]}`);
			expect(writeAt).toBeGreaterThan(scanAt);
			expect(scanAt).toBeGreaterThanOrEqual(0);
		}
		expect(written()).toContain(`users/acct-alice/${p["menu.md"]}`);
	});

	it("does not write a file the scanner matches to its owner's path, quarantines it, alerts, and reports it skipped", async () => {
		scanCsamHash.mockImplementation(async (_blob: Blob, name: string) => {
			order.push(`scan ${name}`);
			return name.endsWith("table.png")
				? { status: "match", bankName: "TEST_BANK", bankContentId: 7, distance: "0" }
				: { status: "clean" };
		});
		const { results, reportFor } = await run();
		const p = await importedPaths();
		const paths = written();
		expect(paths).not.toContain(`users/acct-bob/${p["table.png"]}`);
		expect(paths.filter((w) => w.startsWith("users/acct-bob/"))).toEqual([expect.stringMatching(/^users\/acct-bob\/quarantine\/\d+-.*table\.png$/)]);
		expect(recordCsamMatch).toHaveBeenCalledWith("acct-bob", { bankName: "TEST_BANK", bankContentId: 7, distance: "0" });
		const bob = reportFor("u-bob").files;
		expect(bob.imported).toBe(0);
		expect(bob.skipped).toEqual([{ id: FIXTURE_FILES[2].id, reason: expect.stringContaining("refused by the upload path") }]);
		expect(results.get(FIXTURE_FILES[2].id)).toMatchObject({ ok: false });
		// Alice's files are unaffected.
		expect(paths).toContain(`users/acct-alice/${p["potluck-notes.pdf"]}`);
	});

	it("stores the PDF's text sidecar, holding Open WebUI's extracted text, beside the scanned PDF", async () => {
		const { reportFor } = await run();
		const p = await importedPaths();
		const sidecar = `users/acct-alice/${p["potluck-notes.pdf"]}.txt`;
		expect(written()).toContain(sidecar);
		const call = uploadFile.mock.calls.find((c) => c[0].file.path === sidecar)!;
		expect(await (call[0].file.content as Blob).text()).toContain("Bring a dish that serves six.");
		expect(reportFor("u-alice").files.sidecars).toBe(1);
	});

	it("refuses each picture-bearing file and writes nothing for it when the scanner is down, so a file is never stored unscanned", async () => {
		const { CsamScannerUnreachableError } = await import("$lib/chat/server/storage/csamScan");
		scanCsamHash.mockRejectedValue(new CsamScannerUnreachableError(new Error("ECONNREFUSED")));
		const { reportFor } = await run();
		const p = await importedPaths();
		expect(written()).not.toContain(`users/acct-alice/${p["potluck-notes.pdf"]}`);
		expect(written()).not.toContain(`users/acct-bob/${p["table.png"]}`);
		expect(reportFor("u-alice").files.skipped.map((s) => s.id)).toContain(FIXTURE_FILES[0].id);
		expect(reportFor("u-bob").files.skipped.map((s) => s.id)).toContain(FIXTURE_FILES[2].id);
	});
});
