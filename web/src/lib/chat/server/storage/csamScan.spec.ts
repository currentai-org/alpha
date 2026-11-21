// scanCsamHash's own contract, isolated from uploadCustodialFile's reaction to it (that
// half is covered in custodialStorage.spec.ts, which mocks this module): which provider the config
// selects, failing closed when none is, and the `hma` provider's reading of each answer. fetch is mocked
// here; csamScanHma.ts's header lists the response shapes it reads.
import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const logMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger: logMock }));

const fetchMock = vi.fn();

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	fetchMock.mockReset();
	logMock.warn.mockReset();
	logMock.error.mockReset();
	vi.resetModules();
	vi.stubGlobal("fetch", fetchMock);
});

describe("scanCsamHash — with no scanner configured, the upload is taken and one content-free line says no hash check ran", () => {
	it("returns unscanned (never clean), calls nothing, and logs one line naming no file", async () => {
		const { scanCsamHash, csamScanAllowsUploads, csamScanSkipped } = await import("./csamScan");
		expect(csamScanAllowsUploads()).toBe(true);
		expect(csamScanSkipped()).toBe(true);
		const result = await scanCsamHash(new Blob(["x"]), "holiday-photo.png");
		expect(result).toEqual({ status: "unscanned", reason: "no-scanner" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logMock.warn).toHaveBeenCalledTimes(1);
		expect(logMock.warn.mock.calls[0]).toEqual(["[csam-scan] no known-CSAM hash check ran: no scanner is configured"]);
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("holiday-photo");
	});
});

describe("scanCsamHash — the provider is chosen by config, and a half-written config fails closed", () => {
	it("a base URL with no CSAM_SCAN_PROVIDER uses the hma provider, so a scanner URL that is set still runs", async () => {
		cfg.CSAM_SCAN_BASE_URL = "https://scanner.example.test/";
		fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		const { scanCsamHash, csamScanAllowsUploads, csamScanSkipped } = await import("./csamScan");
		expect(csamScanAllowsUploads()).toBe(true);
		expect(csamScanSkipped()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).resolves.toEqual({ status: "clean" });
		expect(fetchMock.mock.calls[0][0]).toBe("https://scanner.example.test/m/lookup?bypass_coinflip=true");
	});

	it("a set scanner URL that cannot be reached still refuses the upload", async () => {
		cfg.CSAM_SCAN_BASE_URL = "https://scanner.example.test";
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
			CsamScannerUnreachableError
		);
	});

	it("a CSAM_SCAN_PROVIDER that names no known provider refuses every upload, calls nothing, and logs it once", async () => {
		cfg.CSAM_SCAN_PROVIDER = "no-such-provider";
		cfg.CSAM_SCAN_BASE_URL = "https://scanner.example.test";
		const { scanCsamHash, CsamScannerUnconfiguredError, csamScanAllowsUploads } = await import("./csamScan");
		expect(csamScanAllowsUploads()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnconfiguredError);
		await expect(scanCsamHash(new Blob(["x"]), "b.png")).rejects.toBeInstanceOf(CsamScannerUnconfiguredError);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logMock.error).toHaveBeenCalledTimes(1);
		expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining("no-such-provider"));
	});

	it("a provider named with no CSAM_SCAN_BASE_URL refuses every upload and calls nothing", async () => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		const { scanCsamHash, CsamScannerUnconfiguredError, csamScanAllowsUploads } = await import("./csamScan");
		expect(csamScanAllowsUploads()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnconfiguredError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a CSAM_SCAN_TOKEN left set with no CSAM_SCAN_BASE_URL refuses every upload, never takes it unscanned", async () => {
		cfg.CSAM_SCAN_TOKEN = "left-behind";
		const { scanCsamHash, CsamScannerUnconfiguredError, csamScanAllowsUploads, csamScanSkipped } = await import("./csamScan");
		expect(csamScanSkipped()).toBe(false);
		expect(csamScanAllowsUploads()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnconfiguredError);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logMock.error).toHaveBeenCalledTimes(1);
	});
});

describe("scanCsamHash — the proxy's bearer", () => {
	it("sends CSAM_SCAN_TOKEN as a bearer when it is set, and no Authorization header when it is not", async () => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");

		await scanCsamHash(new Blob(["x"]), "a.png");
		expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();

		cfg.CSAM_SCAN_TOKEN = "t0ken";
		await scanCsamHash(new Blob(["x"]), "a.png");
		expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer t0ken" });
	});

	it("reads a 401 from the proxy (a wrong or missing token) as unreachable, never as clean", async () => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnreachableError);
	});
});

describe("scanCsamHash — the hma provider, reachable", () => {
	beforeEach(() => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		cfg.CSAM_SCAN_BASE_URL = "http://127.0.0.1:5101";
	});

	it("returns clean when no bank matches", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ pdq: {} }), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");
		const result = await scanCsamHash(new Blob(["x"]), "a.png");
		expect(result).toEqual({ status: "clean" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:5101/m/lookup?bypass_coinflip=true",
			expect.objectContaining({ method: "POST" })
		);
	});

	it("returns match with the bank name, content id and distance on a hit", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ pdq: { JUPITER_TEST_BANK: [{ bank_content_id: 20, distance: "0" }] } }),
				{ status: 200 }
			)
		);
		const { scanCsamHash } = await import("./csamScan");
		const result = await scanCsamHash(new Blob(["x"]), "a.png");
		expect(result).toEqual({
			status: "match",
			bankName: "JUPITER_TEST_BANK",
			bankContentId: 20,
			distance: "0",
		});
	});

	it("treats a 400 (no computable PDQ hash — a solid-color or low-texture image) as clean, not unreachable", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ message: "invalid signal: invalid PDQ hash" }), { status: 400 })
		);
		const { scanCsamHash } = await import("./csamScan");
		const result = await scanCsamHash(new Blob(["x"]), "blank.png");
		expect(result).toEqual({ status: "clean" });
	});

	it("throws CsamScannerUnreachableError, NOT clean, on a 400 naming a different cause (a malformed request on our side)", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ message: "no such content_type: 'wrongfield'" }), { status: 400 })
		);
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnreachableError);
	});

	it("throws CsamScannerUnreachableError on a 400 with no parseable message", async () => {
		fetchMock.mockResolvedValue(new Response("not json", { status: 400 }));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnreachableError);
	});

	it("still refuses (CsamScannerUnreachableError) after two network failures in a row, never clean", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
			CsamScannerUnreachableError
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("still refuses after two 503s, naming the status, and asks no third time", async () => {
		fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		const scan = scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 });
		await expect(scan).rejects.toBeInstanceOf(CsamScannerUnreachableError);
		await expect(scan).rejects.toThrow("HTTP 503");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries once on a 503 and returns the retry's clean answer, so the file is stored", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ pdq: {} }), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).resolves.toEqual({ status: "clean" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries once on a 502, a 504 or a dropped connection, and a match on the retry is still a match", async () => {
		const { scanCsamHash } = await import("./csamScan");
		const hit = () =>
			new Response(JSON.stringify({ pdq: { BANK: [{ bank_content_id: 7, distance: "0" }] } }), { status: 200 });
		for (const first of [
			() => Promise.resolve(new Response("", { status: 502 })),
			() => Promise.resolve(new Response("", { status: 504 })),
			() => Promise.reject(new TypeError("fetch failed")),
		]) {
			fetchMock.mockReset().mockImplementationOnce(first).mockImplementationOnce(async () => hit());
			await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).resolves.toMatchObject({
				status: "match",
				bankContentId: 7,
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
		}
	});

	it("never retries a timeout, a 500 or a 4xx: one call, then refused", async () => {
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		for (const only of [
			() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
			() => Promise.resolve(new Response("", { status: 500 })),
			() => Promise.resolve(new Response("unauthorized", { status: 401 })),
		]) {
			fetchMock.mockReset().mockImplementation(only);
			await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
				CsamScannerUnreachableError
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it("sends CSAM_SCAN_TOKEN as a bearer when it is set, and no Authorization header when it is not", async () => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");

		await scanCsamHash(new Blob(["x"]), "a.png");
		expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();

		cfg.CSAM_SCAN_TOKEN = "t0ken";
		await scanCsamHash(new Blob(["x"]), "a.png");
		expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer t0ken" });
	});

	it("reads a 401 from the proxy (a wrong or missing token) as unreachable, never as clean", async () => {
		cfg.CSAM_SCAN_PROVIDER = "hma";
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		const { scanCsamHash, CsamScannerUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(CsamScannerUnreachableError);
	});
});

describe("scanCsamHash — CSAM_SCAN=off is honoured on self-host only", () => {
	it("hosted edition with CSAM_SCAN=off and no scanner takes the file as a deployment with no scanner does, and logs the ignored switch once", async () => {
		cfg.CSAM_SCAN = "off";
		cfg.ALPHA_EDITION = "Hosted";
		const { scanCsamHash, csamScanOptedOut } = await import("./csamScan");
		expect(csamScanOptedOut()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).resolves.toEqual({ status: "unscanned", reason: "no-scanner" });
		await expect(scanCsamHash(new Blob(["x"]), "b.png")).resolves.toEqual({ status: "unscanned", reason: "no-scanner" });
		expect(logMock.error).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("self-host edition with CSAM_SCAN=off returns the opted-out result, never clean, with one content-free warn line", async () => {
		cfg.CSAM_SCAN = "off";
		cfg.ALPHA_EDITION = "selfhost";
		const { scanCsamHash, csamScanOptedOut } = await import("./csamScan");
		expect(csamScanOptedOut()).toBe(true);
		const result = await scanCsamHash(new Blob(["x"]), "a.png");
		expect(result).toEqual({ status: "unscanned", reason: "operator-opt-out" });
		expect(logMock.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("a.png");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("CSAM_SCAN=off does not switch off a scanner that is configured", async () => {
		cfg.CSAM_SCAN = "off";
		cfg.ALPHA_EDITION = "selfhost";
		cfg.CSAM_SCAN_BASE_URL = "https://scanner.example.test";
		fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).resolves.toEqual({ status: "clean" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
