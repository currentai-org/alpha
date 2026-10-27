import { posix } from "node:path";

import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { flagEmail } from "$lib/chat/server/flagEmail";

import {
	deleteCustodialFile,
	downloadCustodialFile,
} from "$lib/chat/server/storage/custodialStorage";
import { hasAmbiguousSegment } from "$lib/chat/server/storage/custodialBucket";

import { resolveLocation } from "$lib/chat/server/storage/locations/registry";

import { locationsEnabled, requireStorageAccess, storageFailure } from "../guard";

/** `?location=` names a linked location; honoured only behind the `storage-locations` flag. (CUR-2930) */
async function locationFrom(locals: App.Locals, accountId: string, url: URL): Promise<string | null> {
	const value = url.searchParams.get("location");
	if (!value) return null;
	if (!(await locationsEnabled(accountId, flagEmail(locals.user)))) error(404, "Not found");
	return value;
}

// CUR-1276. Download and delete, against a full bucket key the client got from the listing.
//
// WHY DOWNLOAD IS THE DANGEROUS ONE
//
// Every other endpoint here leaks metadata at worst. This one serves BYTES a person uploaded, from
// aipotluck.org's own origin, to a browser. Two separate hazards stack on that:
//
//   1. Same-origin script execution. An uploaded .html or .svg served with a content type a browser
//      will render is stored XSS against our own origin — the attacker's page runs with our cookies
//      and our session. The defence is not to guess a safe content type; it is to never render at
//      all. Forced attachment, one fixed `application/octet-stream`, `nosniff`.
//   2. Nothing has scanned these files. CUR-1130's open half is malware scanning, and until that
//      exists a download route is precisely the thing that converts "we stored something malicious"
//      into "we served it to someone". Attachment disposition does not fix that; it does mean the
//      browser hands the file to the user as a file rather than executing it in our origin.
//
// The content type is FIXED, never derived. Echoing the sniffed type back would undo (1) for exactly
// the file types that matter, and the module's own sniff exists to decide whether to ACCEPT a file,
// not to describe it on the way out.

/** Pull the bucket key off the query string. A full key, as listing returned it — `downloadCustodialFile`
 *  and `deleteCustodialFile` both re-verify ownership against it regardless of where it came from.
 *
 *  A key the listing returned never contains a `.` or `..` segment, so one that does is
 *  refused rather than resolved. Resolving it would let `x/../quarantine/...` slip past a prefix check
 *  that read the raw string. The normalized form is what every check and the bucket then see.
 *  `hasAmbiguousSegment` also catches the percent-encoded forms and backslashes, which a URL parser
 *  resolves on the way to the bucket and posix.normalize does not; the library repeats the check. */
function bucketPathFrom(url: URL): string {
	const raw = url.searchParams.get("path");
	if (!raw) error(400, "Expected a `path` query parameter.");
	if (hasAmbiguousSegment(raw)) {
		error(400, "A storage path cannot contain `.` or `..` segments, encoded or not, a backslash, or a control character.");
	}
	return posix.normalize(raw);
}

/**
 * `Content-Disposition` for a filename we did not choose.
 *
 * Two forms, per RFC 6266: a quoted ASCII `filename` every client understands, and `filename*` with
 * the real UTF-8 name for those that do. The ASCII one is stripped to a conservative set rather than
 * escaped — a quote, a backslash, a semicolon or a CR/LF in an uploaded name is header injection, and
 * the filename is the one field here that an uploader fully controls.
 */
function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\w.-]+/g, "_").slice(0, 200) || "download";
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	const accountId = await requireStorageAccess(locals);
	const bucketPath = bucketPathFrom(url);

	const location = await locationFrom(locals, accountId, url);
	let blob: Blob | null;
	try {
		blob = location
			? await (await resolveLocation(accountId, location)).read(bucketPath)
			: await downloadCustodialFile(accountId, bucketPath);
	} catch (e) {
		return storageFailure(e);
	}
	// null is @huggingface/hub's "no such file". 404 rather than 500: ownership already passed, so
	// this is a path that could have been theirs and is not there.
	if (!blob) error(404, "Not found");

	const name = bucketPath.split("/").pop() || "download";

	return new Response(blob, {
		headers: {
			// Fixed. See the header note above — this is not a guess at the file's type, it is a
			// refusal to state one.
			"content-type": "application/octet-stream",
			"content-disposition": contentDisposition(name),
			// Belt to the content-type's braces: stops a browser content-sniffing its way back to
			// text/html on a response we deliberately declined to describe.
			"x-content-type-options": "nosniff",
			// Nothing on this response should execute or embed if some future change does let a
			// renderable type through.
			"content-security-policy": "default-src 'none'; sandbox",
			// Someone else's bytes must not sit in a shared cache, and a stale copy after a delete is
			// its own small privacy bug.
			"cache-control": "private, no-store",
		},
	});
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	const accountId = await requireStorageAccess(locals);
	const bucketPath = bucketPathFrom(url);
	const location = await locationFrom(locals, accountId, url);
	try {
		if (location) await (await resolveLocation(accountId, location)).delete(bucketPath);
		else await deleteCustodialFile(accountId, bucketPath);
	} catch (e) {
		return storageFailure(e);
	}
	return json({ ok: true });
};
