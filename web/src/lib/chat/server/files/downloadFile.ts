import { error } from "@sveltejs/kit";
import { fileTypeFromBuffer } from "file-type";
import mimeTypes from "mime-types";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { MessageFile } from "$lib/chat/types/Message";
import { sha256 } from "$lib/chat/utils/sha256";
import { getFileByFilename } from "$lib/chat/server/db/files";
import { logger } from "$lib/chat/server/logger";
import {
	custodialStorageConfigured,
	hubRateLimitedError,
	readCustodialAttachment,
	readGuestAttachment,
	transientHubError,
} from "$lib/chat/server/storage/custodialStorage";
import { attachmentPath } from "$lib/chat/server/storage/attachmentsToCustodial";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import { resolveLocation } from "$lib/chat/server/storage/locations/registry";
import { CustodialCryptoError, type KeyStore } from "$lib/chat/server/storage/custodialCrypto";

/** Who owns the conversation, and the attachment's name from its message reference. With both, the
 * person's My files copy is read first (CUR-2183). A guest's conversation has no owner and names its
 * session instead, whose copy is under guests/<sessionId>/. A conversation moved to an account at sign-in
 * passes both: the owner's copy is read first, then the copy the move left under the former session. */
export type AttachmentOwner = {
	ownerId?: string;
	guestSessionId?: string;
	name?: string;
	mime?: string;
	/** The reference's linked location (CUR-2930); the copy is read there and nowhere else. */
	location?: MessageFile["location"];
	/** Preview-only (faultInjection.ts): every bucket read answers as a throttled Hub does (CUR-3291). */
	fault?: "storage_hub_read_rate_limited";
	/** The turn's own key store (`turnKeyStore`), shared by every read in the turn (CUR-4116). */
	keys?: KeyStore;
};

/**
 * The bucket's copy of one attachment, or null when there is none to use.
 *
 * Null rather than an error for every miss (no bucket, no copy, a copy whose bytes no longer hash to
 * the reference), because attachments stored before `custodial-storage-view` selected their owner are
 * still in the conversation's files table, and the caller falls back to it until CUR-2183 drops it. A
 * bucket that answers with an error is read once more, then logged and reported as `unreadable`: a
 * rate limit or 5xx is not a miss, and a bucket-only attachment has no table row to fall back to
 * (CUR-3291).
 *
 * A long paste is kept in the conversation's pastes folder, out of My files. The reference's mime is
 * the client's word, so it only picks the folder; the bytes found there decide the mime. One read per
 * attachment, since every turn re-reads every attachment against a rate-limited token (CUR-3120).
 */
/** A bucket copy that errored twice, with the last error, so the caller can tell a throttle from a storage failure. */
class Unreadable {
	constructor(readonly cause: unknown) {}
}

/** The bucket errored on an attachment's copy twice and no older copy exists, so the file is there but
 * could not be read this turn. Distinct from the 404 for a file that is gone: asking again can work. */
export class AttachmentReadError extends Error {
	override name = "AttachmentReadError";
}

/** How long a throttled or failed read waits before its one retry, so the retry is not part of the same burst. */
const RETRY_AFTER_MS = 300;

const errorName = (e: unknown) => (e instanceof Error ? e.name : String(e));

async function readCopy(
	sha: string,
	convId: string,
	{ ownerId, guestSessionId, name, mime: refMime, location, fault, keys }: AttachmentOwner
): Promise<(MessageFile & { type: "base64" }) | null | Unreadable> {
	if ((!ownerId && !guestSessionId) || !name) return null;
	if (!location && !custodialStorageConfigured()) return null;
	const paste = refMime === CLIPBOARD_MIME;
	const relativePath = attachmentPath(convId, sha, name, { paste });
	if (!relativePath) return null;
	const read = async (): Promise<Blob | null> => {
		if (fault === "storage_hub_read_rate_limited") throw hubRateLimitedError("fault injection: storage_hub_read_rate_limited");
		if (location) {
			// Only the owner's own locations resolve; anyone else's id is UnknownLocationError.
			return ownerId ? await (await resolveLocation(ownerId, location.id)).read(location.path) : null;
		}
		const own = ownerId ? await readCustodialAttachment(ownerId, relativePath, keys) : null;
		return !own && guestSessionId ? await readGuestAttachment(guestSessionId, relativePath, keys) : own;
	};
	let blob: Blob | null;
	try {
		blob = await read();
	} catch (first) {
		// A sealed copy that won't open is tampering or a lost key (CUR-4115). Falling back to the files
		// table would hide both, and a retry reads the same bytes, so it is unreadable at once.
		if (first instanceof CustodialCryptoError) return new Unreadable(first);
		if (!transientHubError(first)) {
			logger.warn({ convId, err: errorName(first) }, "[files] bucket copy unreadable, using the files table");
			return null;
		}
		try {
			await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
			blob = await read();
		} catch (e) {
			logger.warn({ convId, err: errorName(e) }, "[files] bucket copy unreadable after a retry");
			return new Unreadable(e);
		}
	}
	if (!blob) return null;
	// The sha is over the file's text decoding, the same procedure uploadFile.ts uses to name it.
	if ((await sha256(await blob.text())) !== sha) {
		logger.warn({ convId }, "[files] My files copy does not match its reference, using the files table");
		return null;
	}
	const buffer = Buffer.from(await blob.arrayBuffer());
	const sniffed = (await fileTypeFromBuffer(buffer))?.mime;
	// Only a file with no binary signature was stored as a paste (parseRequest.ts), so a sniffed type wins.
	const mime = sniffed ?? (paste ? CLIPBOARD_MIME : mimeTypes.lookup(name) || "application/octet-stream");
	return { type: "base64", name: `${convId}-${sha}`, value: buffer.toString("base64"), mime };
}

export async function downloadFile(
	sha256Hex: string,
	convId: Conversation["_id"],
	owner: AttachmentOwner = {}
): Promise<MessageFile & { type: "base64" }> {
	const copy = await readCopy(sha256Hex, convId.toString(), owner);
	if (copy && !(copy instanceof Unreadable)) return copy;

	const filename = `${convId.toString()}-${sha256Hex}`;
	const file = await getFileByFilename(filename, convId.toString());

	if (copy instanceof Unreadable && copy.cause instanceof CustodialCryptoError) {
		throw new AttachmentReadError("The stored copy could not be opened", { cause: copy.cause });
	}
	if (!file) {
		if (copy instanceof Unreadable) {
			throw new AttachmentReadError("The storage bucket could not be read", { cause: copy.cause });
		}
		error(404, "File not found");
	}
	if (file.conversationId !== convId.toString()) {
		error(403, "You don't have access to this file.");
	}

	return {
		type: "base64",
		name: file.filename,
		value: Buffer.from(file.data).toString("base64"),
		mime: file.mime ?? "application/octet-stream",
	};
}
