import { error, type RequestHandler } from "@sveltejs/kit";
import { takeUploadChunks } from "$lib/chat/server/db/uploadChunks";
import { CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE } from "$lib/chat/constants/custodialUpload";
import { FileTooLargeError } from "$lib/chat/server/storage/custodialStorage";
import { storageFailure } from "../../guard";
import { writeUpload } from "../../write";
import { chunkFailure, requireChunkedUploads } from "../guard";

// Finish a chunked upload. JSON `{ uploadId, chunks, size, name, folder, location? }`. The
// staged chunks are taken out of the table and joined, then written through the same path as a
// one-request upload, so size, rate, type, the CSAM scan, the image screen and the quota all run on
// the whole file before any byte reaches a bucket. A refused file's chunks are gone either way. (CUR-1780)
export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireChunkedUploads(locals);

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.name !== "string") error(400, "Expected JSON with `uploadId`, `chunks`, `size` and `name`.");
	const { uploadId, chunks, size } = body;
	if (typeof chunks !== "number" || typeof size !== "number") error(400, "`chunks` and `size` must be numbers.");
	// Refused before the chunks are read: an announced size over the ceiling needs no reassembly to
	// know the answer. The real bytes are checked again below.
	if (size > CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE) return storageFailure(new FileTooLargeError(size, CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE));

	let whole: Buffer;
	try {
		whole = await takeUploadChunks(accountId, uploadId as string, chunks, size);
	} catch (e) {
		chunkFailure(e);
	}

	return writeUpload(
		locals,
		request,
		accountId,
		{
			folder: typeof body.folder === "string" ? body.folder : null,
			name: body.name,
			location: typeof body.location === "string" ? body.location : null,
			content: new Blob([new Uint8Array(whole)], typeof body.type === "string" ? { type: body.type } : {}),
		},
		{ maxBytes: CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE }
	);
};
