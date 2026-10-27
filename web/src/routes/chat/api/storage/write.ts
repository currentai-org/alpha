import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { flagEmail } from "$lib/chat/server/flagEmail";

import {
	CUSTODIAL_SUBFOLDERS,
	type CustodialSubfolder,
} from "$lib/chat/server/storage/custodialBucket";
import {
	uploadCustodialFile,
	UploadRateLimitedError,
	type UploadOptions,
} from "$lib/chat/server/storage/custodialStorage";
import { recordUpload, resolveUploadLocation } from "$lib/chat/server/storage/locations/registry";
import { throwIfHubRateLimitFault } from "$lib/chat/server/storage/hubBusy";

import { locationsEnabled, rateLimitedResponse, storageFailure, writeOptions } from "./guard";

// The write half of an upload, shared by the single-request POST in ./+server.ts and the chunked
// upload's finishing request in ./chunks/complete (CUR-1780), so a reassembled file takes exactly the
// path, checks and locations a one-request file does.

/** A `location` the request named, honoured only for an account the `storage-locations` (CUR-2930)
 *  flag selects. Without the flag every request is Alpha storage, exactly as before. */
export async function requestedLocation(
	locals: App.Locals,
	accountId: string,
	value: FormDataEntryValue | null
): Promise<string | null> {
	if (typeof value !== "string" || value === "") return null;
	if (!(await locationsEnabled(accountId, flagEmail(locals.user)))) error(404, "Not found");
	return value;
}

function asSubfolder(value: FormDataEntryValue | null): CustodialSubfolder {
	// Narrow against the layout's own named set rather than accepting any string. resolveUserPath
	// would catch a traversal regardless, but it would happily accept `receipts/` as a new top-level
	// folder — the layout is a contract other code reads, not just a place to put bytes.
	if (typeof value === "string" && (CUSTODIAL_SUBFOLDERS as readonly string[]).includes(value)) {
		return value as CustodialSubfolder;
	}
	error(400, `\`folder\` must be one of: ${CUSTODIAL_SUBFOLDERS.join(", ")}`);
}

/**
 * The last path segment of an uploaded filename, and nothing else.
 *
 * This is NOT a duplicate of resolveUserPath's traversal check. The two guard different contracts:
 * resolveUserPath guards the ACCOUNT boundary and holds (hostile filenames never put a byte
 * outside `users/<me>/`). What it does not guard is the SUBFOLDER, because
 * walking up out of `documents/` lands somewhere still legitimately mine.
 *
 * Unsplit, a filename of `x\0/../../<someone-else's-id>/evil.txt` resolves to
 * `users/<me>/<someone-else's-id>/evil.txt` — inside my own folder, so not a cross-user write, but
 * out of the named subfolder entirely and wearing another account's id as a directory name. That
 * would make `asSubfolder` above decorative, and a listing harder to read than it looks.
 *
 * Splitting on both separators because a Windows client sends backslashes and the bucket does not
 * treat them as separators, so they survive into the key as literal characters.
 */
function basename(name: string): string {
	const last = name.split(/[\\/]/).pop() ?? "";
	// "." and ".." survive the split and would resolve to the folder itself; an empty name gives the
	// bucket a key ending in "/". None of the three is a file, so none of them is a 201.
	if (!last || last === "." || last === "..") error(400, "That filename cannot be stored.");
	// 255 is the limit every filesystem the person might later save this to agrees on. A 4096-byte
	// name is accepted by the bucket and then unusable everywhere else.
	if (last.length > 255) error(400, "That filename is too long (limit 255 characters).");
	return last;
}


/**
 * Write one file the caller has in hand to where the request says: a linked location when the
 * `storage-locations` flag is on, else Alpha storage. Every upload check runs inside the write.
 * `extra` adds options the caller knows and the request does not, such as the chunked ceiling.
 */
export async function writeUpload(
	locals: App.Locals,
	request: Request,
	accountId: string,
	upload: { folder: FormDataEntryValue | null; name: string; location: FormDataEntryValue | null; content: Blob },
	extra: Pick<UploadOptions, "maxBytes"> = {}
): Promise<Response> {
	const folder = asSubfolder(upload.folder);
	const name = basename(upload.name);

	// The relative path, NOT a full bucket key: uploadCustodialFile resolves it against the account's
	// own prefix itself. Passing custodialFilePath()'s output here would resolve twice and bury the
	// file at users/<id>/users/<id>/…, which is a real trap given both functions are one import away.
	const relativePath = `${folder}/${name}`;
	// With the flag on, an upload goes where the request says, else to the account's default. (CUR-2930)
	const useLocations = await locationsEnabled(accountId, flagEmail(locals.user));
	const named = useLocations ? await requestedLocation(locals, accountId, upload.location) : null;

	try {
		await throwIfHubRateLimitFault(request);
		const opts = { ...(await writeOptions(request)), ...extra };
		if (useLocations) {
			const target = await resolveUploadLocation(accountId, named);
			const path = await target.write(folder, name, upload.content, opts);
			await recordUpload(accountId, target.id);
			return json({ ok: true, location: target.id, path }, { status: 201 });
		}
		await uploadCustodialFile(accountId, relativePath, upload.content, opts);
	} catch (e) {
		if (e instanceof UploadRateLimitedError) return rateLimitedResponse(e);
		return storageFailure(e);
	}

	return json({ ok: true }, { status: 201 });
}
