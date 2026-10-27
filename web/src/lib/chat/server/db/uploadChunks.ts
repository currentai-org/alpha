/**
 * The chunks of a My files upload too large for one request, held until the finishing
 * request reassembles them. Every chunk request may land on a different instance, so they wait in
 * Postgres rather than in memory. Nothing here is scanned: the only reader is takeUploadChunks, whose
 * caller runs every upload check on the whole file before any byte reaches a bucket. (CUR-1780)
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "./client";
import { uploadChunks } from "./schema";
import {
	CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE,
	CUSTODIAL_UPLOAD_CHUNK_BYTES,
} from "../../constants/chunkedUpload";

/** The most chunks one file can need at the chunked ceiling. */
const MAX_CHUNKS_PER_UPLOAD = Math.ceil(CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE / CUSTODIAL_UPLOAD_CHUNK_BYTES);

/** Bytes one account may have staged across every unfinished upload: two files at the ceiling. Bounds
 *  what a client that posts chunks and never finishes can park in the database. */
export const MAX_STAGED_BYTES_PER_OWNER = 2 * CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE;

/** An upload untouched this long is abandoned, and the sweep drops it. A 20 MB file on a slow
 *  connection finishes in minutes. */
export const UPLOAD_CHUNK_TTL_MS = 60 * 60 * 1000;

/** The client names its upload; the id only has to be unique among that owner's own uploads. */
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class InvalidChunkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidChunkError";
	}
}
export class StagedBytesExceededError extends Error {
	constructor(readonly staged: number) {
		super(`${staged} bytes are already waiting from unfinished uploads; the limit is ${MAX_STAGED_BYTES_PER_OWNER}`);
		this.name = "StagedBytesExceededError";
	}
}
/** The finishing request named chunks that are not all there, or a size they do not add up to. */
export class IncompleteUploadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IncompleteUploadError";
	}
}

function assertUploadId(uploadId: unknown): asserts uploadId is string {
	if (typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId)) {
		throw new InvalidChunkError("`uploadId` must be 8 to 64 letters, digits, - or _.");
	}
}

/**
 * Stage one chunk. A chunk sent again under the same index replaces the first copy, so a client that
 * retries a chunk whose response it lost does not double-count it.
 * @throws InvalidChunkError, StagedBytesExceededError
 */
export async function putUploadChunk(ownerId: string, uploadId: string, idx: number, data: Buffer): Promise<void> {
	assertUploadId(uploadId);
	if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_CHUNKS_PER_UPLOAD) {
		throw new InvalidChunkError(`\`idx\` must be an integer from 0 to ${MAX_CHUNKS_PER_UPLOAD - 1}.`);
	}
	if (data.length === 0 || data.length > CUSTODIAL_UPLOAD_CHUNK_BYTES) {
		throw new InvalidChunkError(`A chunk must hold 1 to ${CUSTODIAL_UPLOAD_CHUNK_BYTES} bytes.`);
	}
	const db = getDb();
	// Counts everything this owner has staged except the row this write replaces. Two chunk requests
	// racing past the check can overshoot by one chunk; the cap bounds abuse, not exact accounting.
	const [{ staged }] = await db
		.select({ staged: sql<number>`coalesce(sum(octet_length(${uploadChunks.data})), 0)::bigint` })
		.from(uploadChunks)
		.where(
			and(
				eq(uploadChunks.ownerId, ownerId),
				sql`not (${uploadChunks.uploadId} = ${uploadId} and ${uploadChunks.idx} = ${idx})`
			)
		);
	if (Number(staged) + data.length > MAX_STAGED_BYTES_PER_OWNER) throw new StagedBytesExceededError(Number(staged));
	await db
		.insert(uploadChunks)
		.values({ ownerId, uploadId, idx, data })
		.onConflictDoUpdate({
			target: [uploadChunks.ownerId, uploadChunks.uploadId, uploadChunks.idx],
			set: { data, createdAt: new Date() },
		});
}

/**
 * Reassemble an upload and delete its chunks, in one step: the bytes leave the table whether the
 * caller's checks then accept the file or refuse it, so a refused file is not left waiting here.
 * @throws IncompleteUploadError when the chunks are not exactly 0..count-1 or do not total `size`.
 */
export async function takeUploadChunks(ownerId: string, uploadId: string, count: number, size: number): Promise<Buffer> {
	assertUploadId(uploadId);
	if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS_PER_UPLOAD) {
		throw new InvalidChunkError(`\`chunks\` must be an integer from 1 to ${MAX_CHUNKS_PER_UPLOAD}.`);
	}
	const rows = await getDb()
		.delete(uploadChunks)
		.where(and(eq(uploadChunks.ownerId, ownerId), eq(uploadChunks.uploadId, uploadId)))
		.returning({ idx: uploadChunks.idx, data: uploadChunks.data });
	rows.sort((a, b) => a.idx - b.idx);
	if (rows.length !== count || rows.some((r, i) => r.idx !== i)) {
		throw new IncompleteUploadError(`Expected chunks 0 to ${count - 1}; received ${rows.map((r) => r.idx).join(", ") || "none"}.`);
	}
	const whole = Buffer.concat(rows.map((r) => r.data));
	if (whole.length !== size) {
		throw new IncompleteUploadError(`The chunks total ${whole.length} bytes, not the ${size} announced.`);
	}
	return whole;
}

/** Drop every chunk older than the TTL. Run by the daily cleanup cron and before each new chunk. */
export async function sweepAbandonedUploadChunks(now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - UPLOAD_CHUNK_TTL_MS);
	const rows = await getDb()
		.delete(uploadChunks)
		.where(lt(uploadChunks.createdAt, cutoff))
		.returning({ idx: uploadChunks.idx });
	return rows.length;
}

/** For specs: an owner's staged chunk indexes, oldest upload first. */
export async function listUploadChunks(ownerId: string): Promise<{ uploadId: string; idx: number }[]> {
	return getDb()
		.select({ uploadId: uploadChunks.uploadId, idx: uploadChunks.idx })
		.from(uploadChunks)
		.where(eq(uploadChunks.ownerId, ownerId))
		.orderBy(asc(uploadChunks.createdAt), asc(uploadChunks.idx));
}
