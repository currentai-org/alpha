import { error } from "@sveltejs/kit";

import {
	InvalidUserIdError,
	OwnershipMismatchError,
	PathEscapesUserPrefixError,
} from "$lib/chat/server/storage/custodialBucket";
import {
	CsamMatchError,
	FileTooLargeError,
	StorageQuotaExceededError,
	UnsupportedFileTypeError,
	ImageInputNotAllowedError,
	DocumentInputNotAllowedError,
	UploadRateLimitedError,
} from "$lib/chat/server/storage/custodialStorage";
import { custodialStorageViewEnabledForUser } from "$lib/chat/server/storage/custodialStorageGate";
import {
	CsamScannerUnconfiguredError,
	HmaUnreachableError,
	UPLOAD_NOT_SCANNED_MESSAGE,
} from "$lib/chat/server/storage/csamScan";
import { UnscannableFileError, UNSCANNABLE_FILE_MESSAGE } from "$lib/chat/server/storage/embeddedImageScan";
import {
	ImageScreenUnavailableError,
	TooManyImagesToScreenError,
	tooManyImagesMessage,
} from "$lib/chat/server/storage/uploadImageGuard";
import { json } from "$lib/chat/server/api/utils/json";
import { hubBusyResponse } from "$lib/chat/server/storage/hubBusy";
import { STORAGE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { logger } from "$lib/chat/server/logger";
import { storageLocationsEnabledForUser } from "$lib/chat/server/storage/locations/gate";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { LocationUnavailableError, UnknownLocationError } from "$lib/chat/server/storage/locations/types";
import { LinkRefusedError, PathOutsideLocationError } from "$lib/chat/server/storage/locations/hfBucketLocation";
import { LocationChoiceRequiredError } from "$lib/chat/server/storage/locations/registry";
import { documentAttachmentsEnabled } from "$lib/chat/server/documentAttachmentsGate";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { multimodalEnabled } from "$lib/chat/server/textOnly";

// CUR-1276. The two things every custodial storage endpoint has to do before it touches the bucket,
// in one place so a new endpoint cannot ship with only one of them.
//
// This matters more here than on most routes. ONE shared `HF_BUCKETS_TOKEN` holds every person's
// files, so `assertOwnership`'s path check is the only thing standing between two users — there is
// no per-user credential underneath as a second layer, and a bug is a cross-user read rather than a
// leaked field (an unnormalized path walking out of the prefix is the failure to guard against,
// CUR-928). CUR-1288 is the open question about the credential model itself.

/**
 * Resolve the account id this request is allowed to act as, or throw the right HTTP error.
 *
 * The returned id is the ONLY user identity any handler may pass to the storage module. Nothing the
 * client sends is an identity — not a body field, not a query param, not a header.
 */
export async function requireStorageAccess(locals: App.Locals): Promise<string> {
	const user = locals.user;
	// 401, not 403: an anonymous caller has somewhere to go from here.
	if (!user) error(401, "Sign in to use storage.");

	const accountId = user._id.toString();

	// 404, not 403, when the flag is off. A dark feature should be indistinguishable from one that was
	// never built — a 403 confirms the surface exists and invites someone to come back for it. This is
	// also the shape the flag's own gate expects: off means absent.
	if (!(await custodialStorageViewEnabledForUser(accountId))) error(404, "Not found");

	return accountId;
}

/**
 * Storage access, plus the `storage-locations` flag. 404 when either is off, for the same
 * reason requireStorageAccess gives: a dark feature looks unbuilt. (CUR-2930)
 */
export async function requireLocationsAccess(locals: App.Locals): Promise<string> {
	const accountId = await requireStorageAccess(locals);
	if (!(await storageLocationsEnabledForUser(accountId, flagEmail(locals.user)))) error(404, "Not found");
	return accountId;
}

/** Whether this account may use locations, for routes that also serve Alpha storage without them. */
export async function locationsEnabled(accountId: string, email: string | undefined): Promise<boolean> {
	return storageLocationsEnabledForUser(accountId, email);
}

/**
 * Turn a storage-module error into the status it deserves, or rethrow.
 *
 * Every limit in CUR-1129 is a typed error precisely so a route can do this rather than let a quota
 * degrade into a suggestion. A handler that swallows one of these has un-enforced the limit while
 * still importing it.
 */
function storageError(e: unknown): never {
	logScanRefusal(e);
	// The three path/identity failures all mean the same thing to a caller: not yours. They are
	// deliberately NOT distinguished in the response — telling someone whether a path exists but
	// belongs to another person, versus is malformed, is a free oracle over other people's files.
	if (
		e instanceof OwnershipMismatchError ||
		e instanceof PathEscapesUserPrefixError ||
		e instanceof InvalidUserIdError
	) {
		error(403, "Not your file.");
	}

	// CUR-2930. A path outside a linked location's folder is "not yours" too, and an id that is not
	// this account's is a 404, the same non-distinguishing posture as above.
	if (e instanceof PathOutsideLocationError) error(403, "Not your file.");
	if (e instanceof UnknownLocationError) error(404, "Not found");
	// 409: the request was fine, the location is in a state that refuses it until the person acts.
	if (e instanceof LocationUnavailableError) error(409, e.message);
	if (e instanceof LocationChoiceRequiredError) error(409, "Choose where this file should go.");
	if (e instanceof LinkRefusedError) error(400, e.message);

	if (e instanceof FileTooLargeError) error(413, e.message);
	if (e instanceof UnsupportedFileTypeError) error(415, e.message);
	if (e instanceof ImageInputNotAllowedError) error(415, e.message);
	if (e instanceof DocumentInputNotAllowedError) error(415, e.message);
	// 507 rather than 413: the request is not too large, the account is too full. A client that
	// retries a smaller file on 413 would spin forever against a quota.
	if (e instanceof StorageQuotaExceededError) error(507, e.message);
	if (e instanceof UploadRateLimitedError) {
		error(429, e.message);
	}
	// 422, not 403/415: the file is well-formed and of an allowed type, but its content matched a known
	// CSAM signal — a distinct rejection reason from "not yours" or "wrong format".
	if (e instanceof CsamMatchError) error(422, "This file could not be uploaded.");
	// 503: the file could not be scanned, because no scanner is configured or the configured one did
	// not answer. Fail closed (CUR-1136, CUR-2382), with the same line chat shows.
	if (e instanceof CsamScannerUnconfiguredError) {
		// A config error, not a service failure: nothing is scanned until CSAM_SCAN_BASE_URL is set, so it is
		// logged at error, as chat's own refusal is (parseRequest.ts).
		logger.error("[csam-scan] CSAM_SCAN_BASE_URL is unset, so a My files upload was refused (config error)");
		error(503, UPLOAD_NOT_SCANNED_MESSAGE);
	}
	if (e instanceof HmaUnreachableError) error(503, UPLOAD_NOT_SCANNED_MESSAGE);
	// 422: a picture inside the file could not be decoded, so it could not be checked (CUR-987). A
	// retry gives the same answer, unlike the 503 above.
	if (e instanceof UnscannableFileError) error(422, UNSCANNABLE_FILE_MESSAGE);
	// The child-safety screen on stored pictures fails closed the way the hash scan does. (CUR-3201)
	if (e instanceof ImageScreenUnavailableError) error(503, UPLOAD_NOT_SCANNED_MESSAGE);
	if (e instanceof TooManyImagesToScreenError) {
		error(422, tooManyImagesMessage(e.count));
	}
	throw e;
}

/**
 * Log which upload check refused a file and why. Every one of these reaches the person as a single
 * line of copy, so without this line a refusal in production cannot be traced to its check (CUR-4658).
 * The messages carry a status code or a reason, never file content or a file name.
 */
function logScanRefusal(e: unknown): void {
	const check =
		e instanceof HmaUnreachableError
			? "csam-hash"
			: e instanceof ImageScreenUnavailableError
				? "image-screen"
				: e instanceof UnscannableFileError
					? "embedded-images"
					: e instanceof TooManyImagesToScreenError
						? "image-screen-count"
						: e instanceof CsamMatchError
							? "csam-match"
							: null;
	if (!check) return;
	logger.warn({ check, reason: e instanceof Error ? e.message : String(e) }, "[upload-guard] upload refused");
}

/**
 * A storage route's answer to any error: storageError's status, except when the storage host throttled
 * the shared storage token (3,000 Hub calls per 5 minutes on the team plan). That is a 503 that
 * reads as busy and carries `Retry-After` until the window resets (CUR-3120, CUR-3680).
 */
export function storageFailure(e: unknown): Response {
	return hubBusyResponse(e, STORAGE_BUSY_MESSAGE, "storage") ?? storageError(e);
}

/** Seconds to put in `Retry-After` for a rate-limited upload, rounded up and floored at 1. */
function retryAfterSeconds(e: UploadRateLimitedError): number {
	return Math.max(1, Math.ceil(e.retryAfterMs / 1000));
}

/**
 * The content gates every write takes, built once so an upload and a copy or move can't drift apart.
 * A gate added to uploads but not to transfers would make a transfer the way around it (CUR-2931).
 */
export async function writeOptions(request: Request) {
	return {
		scannerDown: (await resolveFaultInjection(request)) === "csam_scanner_down",
		// An image only for an account the `multimodal` flag selects (team-only on preview). (CUR-2725)
		imagesAllowed: multimodalEnabled(),
		// A document only where its pictures may be extracted in-process (team-only). (CUR-987)
		documentsAllowed: documentAttachmentsEnabled(),
	};
}

/**
 * 429 with the `Retry-After` header: rate limiting is the one limit whose answer the client can act
 * on, so it gets the header that says how long to wait. Everything else goes through storageError.
 */
export function rateLimitedResponse(e: UploadRateLimitedError): Response {
	return json({ message: e.message }, { status: 429, headers: { "retry-after": String(retryAfterSeconds(e)) } });
}
