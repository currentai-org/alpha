/**
 * The chunks of a My files upload too large for one request. The contracts: a file is
 * reassembled in index order whatever order its chunks arrived in, and only when every chunk is there
 * and they add up to the announced size; taking an upload removes its chunks whether or not it was
 * whole; one account cannot stage more than the cap, nor take another account's chunks; and the sweep
 * drops only uploads abandoned past the TTL. (CUR-1780)
 */
import { afterEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { uploadChunks } from "$lib/chat/server/db/schema";
import {
	IncompleteUploadError,
	InvalidChunkError,
	MAX_STAGED_BYTES_PER_OWNER,
	StagedBytesExceededError,
	UPLOAD_CHUNK_TTL_MS,
	listUploadChunks,
	putUploadChunk,
	sweepAbandonedUploadChunks,
	takeUploadChunks,
} from "$lib/chat/server/db/uploadChunks";
import { CUSTODIAL_UPLOAD_CHUNK_BYTES } from "$lib/chat/constants/chunkedUpload";

// Invented owner ids, prefixed so cleanup touches nothing another spec wrote.
const OWNER = "spec-upload-chunks-owner-a";
const OTHER = "spec-upload-chunks-owner-b";
const UPLOAD = "specupload0001";

const bytes = (fill: number, length: number) => Buffer.alloc(length, fill);

describe.sequential("upload chunks (CUR-1780)", () => {
	afterEach(async () => {
		await getDb().delete(uploadChunks).where(like(uploadChunks.ownerId, "spec-upload-chunks-%"));
	});

	it("reassembles chunks in index order whatever order they arrived in, and leaves none behind", async () => {
		await putUploadChunk(OWNER, UPLOAD, 2, bytes(3, 5));
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(1, 10));
		await putUploadChunk(OWNER, UPLOAD, 1, bytes(2, 10));

		const whole = await takeUploadChunks(OWNER, UPLOAD, 3, 25);

		expect([...whole.subarray(0, 10)].every((b) => b === 1)).toBe(true);
		expect([...whole.subarray(10, 20)].every((b) => b === 2)).toBe(true);
		expect([...whole.subarray(20)].every((b) => b === 3)).toBe(true);
		expect(await listUploadChunks(OWNER)).toEqual([]);
	});

	it("refuses an upload with a chunk missing, and drops the chunks it did have", async () => {
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(1, 10));
		await putUploadChunk(OWNER, UPLOAD, 2, bytes(3, 10));

		await expect(takeUploadChunks(OWNER, UPLOAD, 3, 30)).rejects.toBeInstanceOf(IncompleteUploadError);
		expect(await listUploadChunks(OWNER)).toEqual([]);
	});

	it("refuses chunks that do not add up to the announced size", async () => {
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(1, 10));

		await expect(takeUploadChunks(OWNER, UPLOAD, 1, 11)).rejects.toBeInstanceOf(IncompleteUploadError);
	});

	it("never hands one account's chunks to another", async () => {
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(1, 10));

		await expect(takeUploadChunks(OTHER, UPLOAD, 1, 10)).rejects.toBeInstanceOf(IncompleteUploadError);
		expect(await listUploadChunks(OWNER)).toEqual([{ uploadId: UPLOAD, idx: 0 }]);
	});

	it("a chunk sent again replaces the first copy rather than counting twice", async () => {
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(1, 10));
		await putUploadChunk(OWNER, UPLOAD, 0, bytes(9, 10));

		const whole = await takeUploadChunks(OWNER, UPLOAD, 1, 10);
		expect(whole.every((b) => b === 9)).toBe(true);
	});

	it("refuses a chunk that would take one account past the staged-bytes cap", async () => {
		const full = Math.floor(MAX_STAGED_BYTES_PER_OWNER / CUSTODIAL_UPLOAD_CHUNK_BYTES);
		for (let i = 0; i < full; i++) {
			// Five chunks per upload at most, so spread the cap across uploads.
			await putUploadChunk(OWNER, `specupload${String(Math.floor(i / 5)).padStart(4, "0")}`, i % 5, bytes(1, CUSTODIAL_UPLOAD_CHUNK_BYTES));
		}

		await expect(putUploadChunk(OWNER, "specuploadlast", 0, bytes(1, 1))).rejects.toBeInstanceOf(StagedBytesExceededError);
		// Another account is unaffected by this one's staged bytes.
		await expect(putUploadChunk(OTHER, UPLOAD, 0, bytes(1, 10))).resolves.toBeUndefined();
	});

	it("refuses an index past the most a 20 MB file needs, and an empty or oversized chunk", async () => {
		await expect(putUploadChunk(OWNER, UPLOAD, 5, bytes(1, 10))).rejects.toBeInstanceOf(InvalidChunkError);
		await expect(putUploadChunk(OWNER, UPLOAD, 0, Buffer.alloc(0))).rejects.toBeInstanceOf(InvalidChunkError);
		await expect(putUploadChunk(OWNER, UPLOAD, 0, bytes(1, CUSTODIAL_UPLOAD_CHUNK_BYTES + 1))).rejects.toBeInstanceOf(
			InvalidChunkError
		);
		await expect(putUploadChunk(OWNER, "../x", 0, bytes(1, 10))).rejects.toBeInstanceOf(InvalidChunkError);
	});

	it("the sweep drops an upload abandoned past the TTL and keeps a fresh one", async () => {
		await putUploadChunk(OWNER, "specuploadold1", 0, bytes(1, 10));
		await putUploadChunk(OWNER, "specuploadnew1", 0, bytes(1, 10));
		await getDb()
			.update(uploadChunks)
			.set({ createdAt: new Date(Date.now() - UPLOAD_CHUNK_TTL_MS - 60_000) })
			.where(like(uploadChunks.uploadId, "specuploadold%"));

		const dropped = await sweepAbandonedUploadChunks();

		expect(dropped).toBeGreaterThanOrEqual(1);
		expect(await listUploadChunks(OWNER)).toEqual([{ uploadId: "specuploadnew1", idx: 0 }]);
	});
});
