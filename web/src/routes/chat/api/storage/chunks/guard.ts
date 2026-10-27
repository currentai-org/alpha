import { error } from "@sveltejs/kit";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { chunkedUploadsEnabledForUser } from "$lib/chat/server/storage/chunkedUploadGate";
import {
	IncompleteUploadError,
	InvalidChunkError,
	StagedBytesExceededError,
} from "$lib/chat/server/db/uploadChunks";
import { requireStorageAccess } from "../guard";

/** My files access plus the `chunked-uploads` flag; 404 when either is off, as a dark feature looks
 *  unbuilt (requireStorageAccess). Returns the account id. */
export async function requireChunkedUploads(locals: App.Locals): Promise<string> {
	const accountId = await requireStorageAccess(locals);
	if (!(await chunkedUploadsEnabledForUser(accountId, flagEmail(locals.user)))) error(404, "Not found");
	return accountId;
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
