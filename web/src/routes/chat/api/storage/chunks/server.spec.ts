/**
 * The two routes that carry a My files upload too large for one request. The contracts: both
 * answer 404 while the `chunked-uploads` flag is off, so the path is absent rather than refused; a
 * finishing request announcing more than the 20 MB ceiling is refused 413 before any staged chunk is
 * read; and a finished upload goes through the one-request upload's own write path with the whole file
 * and the 20 MB ceiling, so every content check runs on the reassembled bytes. (CUR-1780)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The chunk store's functions are stubbed, its typed errors are not: the guard maps with `instanceof`.
const { putUploadChunk, takeUploadChunks, sweepAbandonedUploadChunks } = vi.hoisted(() => ({
	putUploadChunk: vi.fn(),
	takeUploadChunks: vi.fn(),
	sweepAbandonedUploadChunks: vi.fn(),
}));
const { custodialStorageViewEnabledForUser, chunkedUploadsEnabledForUser, writeUpload } = vi.hoisted(() => ({
	custodialStorageViewEnabledForUser: vi.fn(),
	chunkedUploadsEnabledForUser: vi.fn(),
	writeUpload: vi.fn(),
}));

vi.mock("$lib/chat/server/db/uploadChunks", async (importOriginal) => ({
	...(await importOriginal<object>()),
	putUploadChunk,
	takeUploadChunks,
	sweepAbandonedUploadChunks,
}));
vi.mock("$lib/chat/server/storage/custodialStorageGate", () => ({
	CUSTODIAL_STORAGE_VIEW_FLAG: "custodial-storage-view",
	custodialStorageViewEnabledForUser,
}));
vi.mock("$lib/chat/server/storage/chunkedUploadGate", () => ({
	chunkedUploadsEnabledForUser,
}));
vi.mock("$lib/chat/server/vercelBackground", () => ({ runInBackground: (p: Promise<unknown>) => p }));
vi.mock("../write", () => ({ writeUpload }));

import { IncompleteUploadError, StagedBytesExceededError } from "$lib/chat/server/db/uploadChunks";
import { CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE } from "$lib/chat/constants/custodialUpload";
import { POST as postChunk } from "./+server";
import { POST as postComplete } from "./complete/+server";

// 24 hex, the shape locals.user._id carries. Invented.
const ACCOUNT_ID = "cccccccccccccccccccccccc";
const locals = { user: { _id: { toString: () => ACCOUNT_ID }, email: "person@example.org" } };

function chunkRequest(idx = "0", uploadId = "specupload0001"): Request {
	const form = new FormData();
	form.set("uploadId", uploadId);
	form.set("idx", idx);
	form.set("chunk", new Blob([new Uint8Array([1, 2, 3])]));
	return new Request("http://localhost/chat/api/storage/chunks", { method: "POST", body: form });
}

function completeRequest(body: Record<string, unknown>): Request {
	return new Request("http://localhost/chat/api/storage/chunks/complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A route's status whether it returned a Response or threw SvelteKit's `error()`. */
async function statusOf(run: () => Promise<Response>): Promise<number> {
	try {
		return (await run()).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

const finish = { uploadId: "specupload0001", chunks: 3, size: 11_000_000, name: "big.pdf", folder: "documents" };

beforeEach(() => {
	vi.clearAllMocks();
	custodialStorageViewEnabledForUser.mockResolvedValue(true);
	chunkedUploadsEnabledForUser.mockResolvedValue(true);
	putUploadChunk.mockResolvedValue(undefined);
	sweepAbandonedUploadChunks.mockResolvedValue(0);
	takeUploadChunks.mockResolvedValue(Buffer.alloc(11_000_000, 7));
	writeUpload.mockResolvedValue(new Response(null, { status: 201 }));
});

describe("chunked uploads are absent while the flag is off (CUR-1780)", () => {
	it("answers 404 on a chunk and stages nothing", async () => {
		chunkedUploadsEnabledForUser.mockResolvedValue(false);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postChunk({ locals, request: chunkRequest() }))).toBe(404);
		expect(putUploadChunk).not.toHaveBeenCalled();
	});

	it("answers 404 on a finish and reads no chunks", async () => {
		chunkedUploadsEnabledForUser.mockResolvedValue(false);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postComplete({ locals, request: completeRequest(finish) }))).toBe(404);
		expect(takeUploadChunks).not.toHaveBeenCalled();
	});
});

describe("a chunk", () => {
	it("is staged under the signed-in account, never an id off the request", async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postChunk({ locals, request: chunkRequest("2") }))).toBe(201);
		expect(putUploadChunk).toHaveBeenCalledWith(ACCOUNT_ID, "specupload0001", 2, expect.any(Buffer));
	});

	it("past the account's staged-bytes cap answers 409, so the client stops rather than shrinking", async () => {
		putUploadChunk.mockRejectedValue(new StagedBytesExceededError(40_000_000));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postChunk({ locals, request: chunkRequest() }))).toBe(409);
	});
});

describe("finishing an upload", () => {
	it("refuses an announced size over 20 MB with 413 before reading any staged chunk", async () => {
		const request = completeRequest({ ...finish, size: CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE + 1 });
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postComplete({ locals, request }))).toBe(413);
		expect(takeUploadChunks).not.toHaveBeenCalled();
		expect(writeUpload).not.toHaveBeenCalled();
	});

	it("writes the whole reassembled file through the one-request write path with the 20 MB ceiling", async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postComplete({ locals, request: completeRequest(finish) }))).toBe(201);
		expect(takeUploadChunks).toHaveBeenCalledWith(ACCOUNT_ID, "specupload0001", 3, 11_000_000);
		const [, , account, upload, extra] = writeUpload.mock.calls[0];
		expect(account).toBe(ACCOUNT_ID);
		expect(upload).toMatchObject({ folder: "documents", name: "big.pdf", location: null });
		expect((upload.content as Blob).size).toBe(11_000_000);
		expect(extra).toEqual({ maxBytes: CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE });
	});

	it("refuses an upload with chunks missing with 400 and writes nothing", async () => {
		takeUploadChunks.mockRejectedValue(new IncompleteUploadError("missing chunk 1"));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		expect(await statusOf(() => postComplete({ locals, request: completeRequest(finish) }))).toBe(400);
		expect(writeUpload).not.toHaveBeenCalled();
	});
});
