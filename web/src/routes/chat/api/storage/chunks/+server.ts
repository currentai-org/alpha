import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { putUploadChunk, sweepAbandonedUploadChunks } from "$lib/chat/server/db/uploadChunks";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { logger } from "$lib/chat/server/logger";
import { chunkFailure, requireChunkedUploads } from "./guard";

// One chunk of a My files upload too large for a single request. Multipart, with `uploadId`
// (the client's name for this upload), `idx` (0-based) and `chunk`. The chunk is staged unread; the
// finishing request in ./complete reassembles the file and runs every upload check on it whole. (CUR-1780)
export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireChunkedUploads(locals);

	const form = await request.formData();
	const chunk = form.get("chunk");
	if (!(chunk instanceof Blob)) error(400, "Expected a multipart `chunk` part.");
	const idxRaw = form.get("idx");
	const idx = typeof idxRaw === "string" && /^\d+$/.test(idxRaw) ? Number(idxRaw) : NaN;

	// The first chunk of each upload sweeps everyone's abandoned ones, so an hour-old chunk never
	// waits for the daily cron. Off the request's path: a sweep failure must not refuse an upload.
	if (idx === 0) {
		void runInBackground(
			sweepAbandonedUploadChunks().catch((e) => logger.warn(e, "[storage] upload chunk sweep failed"))
		);
	}

	try {
		await putUploadChunk(accountId, form.get("uploadId") as string, idx, Buffer.from(await chunk.arrayBuffer()));
	} catch (e) {
		chunkFailure(e);
	}
	return json({ ok: true }, { status: 201 });
};
