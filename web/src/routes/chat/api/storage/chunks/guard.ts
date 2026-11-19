import { error } from "@sveltejs/kit";
import {
	IncompleteUploadError,
	InvalidChunkError,
	StagedBytesExceededError,
} from "$lib/chat/server/db/uploadChunks";
import { requireStorageAccess } from "../guard";

/** My files access; 404 when it is off, as a dark feature looks unbuilt (requireStorageAccess).
 *  Returns the account id. The `chunked-uploads` flag that also gated these routes was retired once
 *  it was on everywhere. */
export async function requireChunkedUploads(locals: App.Locals): Promise<string> {
	return requireStorageAccess(locals);
}

/** The chunk store's typed errors as statuses; anything else is rethrown. */
export function chunkFailure(e: unknown): never {
	if (e instanceof InvalidChunkError) error(400, e.message);
	// 409: the request is fine, but the account's unfinished uploads must finish or expire first.
	if (e instanceof StagedBytesExceededError) {
		error(409, "Too many unfinished uploads. Wait for them to finish, or try again in an hour.");
	}
	if (e instanceof IncompleteUploadError) error(400, e.message);
	throw e;
}
