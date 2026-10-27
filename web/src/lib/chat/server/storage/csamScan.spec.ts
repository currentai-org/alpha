// scanCsamHash's own contract, isolated from uploadCustodialFile's reaction to it (that
// half is covered in custodialStorage.spec.ts, which mocks this module). fetch is mocked here; HMA's
// real API shape (a match/no-match/degenerate-hash 400) is confirmed separately against the running
// local stack in web/hma/ — see this file's own header for the live-probed response shapes. (CUR-1136)
import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const fetchMock = vi.fn();

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("scanCsamHash — no scanner configured fails closed (CUR-2382)", () => {
	it("refuses (throws CsamScannerUnconfiguredError), never returns clean, when CSAM_SCAN_BASE_URL is unset", async () => {
		const { scanCsamHash, CsamScannerUnconfiguredError, csamScanConfigured } = await import("./csamScan");
		expect(csamScanConfigured()).toBe(false);
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(
			CsamScannerUnconfiguredError
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("scanCsamHash — the Fly proxy's bearer (CUR-2382)", () => {
	it("sends CSAM_SCAN_TOKEN as a bearer when it is set, and no Authorization header when it is not", async () => {
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
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(HmaUnreachableError);
	});
});

describe("scanCsamHash — HMA reachable", () => {
	beforeEach(() => {
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

	it("throws HmaUnreachableError, NOT clean, on a 400 naming a different cause (a malformed request on our side)", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ message: "no such content_type: 'wrongfield'" }), { status: 400 })
		);
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(HmaUnreachableError);
	});

	it("throws HmaUnreachableError on a 400 with no parseable message", async () => {
		fetchMock.mockResolvedValue(new Response("not json", { status: 400 }));
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(HmaUnreachableError);
	});

	it("still refuses (HmaUnreachableError) after two network failures in a row, never clean", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
			HmaUnreachableError
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("still refuses after two 503s, naming the status, and asks no third time (CUR-4671)", async () => {
		fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		const scan = scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 });
		await expect(scan).rejects.toBeInstanceOf(HmaUnreachableError);
		await expect(scan).rejects.toThrow("HTTP 503");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries once on a 503 and returns the retry's clean answer, so the file is stored (CUR-4671)", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ pdq: {} }), { status: 200 }));
		const { scanCsamHash } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).resolves.toEqual({ status: "clean" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries once on a 502, a 504 or a dropped connection, and a match on the retry is still a match (CUR-4671)", async () => {
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

	it("never retries a timeout, a 500 or a 4xx: one call, then refused (CUR-4671)", async () => {
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		for (const only of [
			() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
			() => Promise.resolve(new Response("", { status: 500 })),
			() => Promise.resolve(new Response("unauthorized", { status: 401 })),
		]) {
			fetchMock.mockReset().mockImplementation(only);
			await expect(scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
				HmaUnreachableError
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it("sends CSAM_SCAN_TOKEN as a bearer when it is set, and no Authorization header when it is not", async () => {
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
		cfg.CSAM_SCAN_BASE_URL = "https://hma.example.test";
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		const { scanCsamHash, HmaUnreachableError } = await import("./csamScan");
		await expect(scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(HmaUnreachableError);
	});
});
