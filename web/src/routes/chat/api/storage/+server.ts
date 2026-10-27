import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";

import { listCustodialFiles } from "$lib/chat/server/storage/custodialStorage";

import { resolveLocation } from "$lib/chat/server/storage/locations/registry";

import { requireStorageAccess, storageFailure } from "./guard";
import { requestedLocation, writeUpload } from "./write";
import { throwIfHubRateLimitFault } from "$lib/chat/server/storage/hubBusy";

// The front door CUR-899 never built. List and upload live here; download and delete are
// one level down in ./file, because download is the endpoint where a bug serves another person's
// BYTES rather than their filenames, and it earns its own file and its own header discipline. (CUR-1276)

/** One file, as the client sees it. Deliberately not the raw @huggingface/hub entry: that carries
 *  bucket-shaped fields (`oid`, `lfs`, `type`) a storage view has no use for, and shipping a vendor
 *  struct straight out of an endpoint is how the next field it gains becomes our public contract. */
type StorageFile = {
	/** Full bucket key, `users/<id>/<folder>/<name>`. Round-trip this to download or delete — it is
	 *  the shape both of those expect; a hand-built path will not match it. */
	path: string;
	size: number;
	/** When the bucket took the file (CUR-3289), so My files can say when each copy was added. */
	addedAt?: string;
};

export const GET: RequestHandler = async ({ locals, url, request }) => {
	const accountId = await requireStorageAccess(locals);
	const location = await requestedLocation(locals, accountId, url.searchParams.get("location"));
	if (location) {
		try {
			return json({ files: await (await resolveLocation(accountId, location)).list() });
		} catch (e) {
			return storageFailure(e);
		}
	}
	try {
		await throwIfHubRateLimitFault(request);
		const entries = await listCustodialFiles(accountId);
		const files: StorageFile[] = entries.map((e) => ({ path: e.path, size: e.size, addedAt: e.uploadedAt }));
		return json({ files });
	} catch (e) {
		return storageFailure(e);
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = await requireStorageAccess(locals);

	const form = await request.formData();
	const file = form.get("file");
	if (!(file instanceof File)) error(400, "Expected a multipart `file` part.");
	return writeUpload(locals, request, accountId, {
		folder: form.get("folder"),
		name: file.name,
		location: form.get("location"),
		content: file,
	});
};
