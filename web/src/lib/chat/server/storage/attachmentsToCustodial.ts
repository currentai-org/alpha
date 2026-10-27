import { logger } from "$lib/chat/server/logger";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { MessageFile } from "$lib/chat/types/Message";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import { sha256 } from "$lib/chat/utils/sha256";
import { uploadFile } from "$lib/chat/server/files/uploadFile";
import {
	custodialStorageConfigured,
	hubRateLimitedError,
	hubRateLimitedUrl,
	storeChatAttachment,
	StorageQuotaExceededError,
	PASTES_DIRNAME,
} from "$lib/chat/server/storage/custodialStorage";
import type { FaultInjectionName } from "$lib/chat/server/textGeneration/faultInjection";
import {
	custodialStorageForGuestsEnabled,
	custodialStorageViewEnabledForUser,
} from "$lib/chat/server/storage/custodialStorageGate";
import { storageLocationsEnabledForUser } from "$lib/chat/server/storage/locations/gate";
import { LocationChoiceRequiredError, resolveUploadLocation } from "$lib/chat/server/storage/locations/registry";
import type { StorageLocation } from "$lib/chat/server/storage/locations/types";

// A file a signed-in person attaches in chat lives in My files, under
// `users/<id>/conversations/<conversationId>/<sha>/<name>`, and a guest's under the same path in
// `guests/<sessionId>/`. The conversation id in the path is the link back to the chat that used it.
// The sha keeps two attachments with one name apart, and lets a turn find the file from the message's
// own file reference; My files shows the last segment, so the person still sees the name they
// attached. Delete-all (wipeCustodialFiles), deleting the chat (deleteCustodialFolders) and the data
// export all walk the prefix, so a file written here is deleted and exported with no change to them.
//
// With `custodial-storage-view` on for the owner, the bucket is where an attachment goes first. The
// bucket never holds a turn up: each write has BUCKET_WRITE_TIMEOUT_MS, and a write that times out or
// fails (a throttled Hub token, any Hub error, a guest's full quota) puts that file in the
// conversation's files table instead, which downloadFile.ts reads when the bucket has no copy. A
// signed-in person's full quota refuses the turn instead (CUR-3235).
// With the flag off (or no bucket on the deployment), attachments go to the table as before. (CUR-2172, CUR-2183)

/** The last path segment of an attachment's name, or undefined when there is no usable one. */
function storedName(name: string): string | undefined {
	const last = name.split(/[\\/]/).pop() ?? "";
	if (!last || last === "." || last === ".." || last.length > 255) return undefined;
	return last;
}

/**
 * A name that can be stored for any attachment: the last path segment, with `#` and `?` replaced, cut to 255 characters with
 * its extension kept, or "attachment" when nothing usable is left. A name the bucket can't take is
 * cleaned up and kept, never a reason to refuse the file.
 */
function attachmentName(name: string): string {
	// `#` and `?` become `_`: the Hub client puts the path into the download URL unencoded, so a stored
	// `a#b.txt` reads back as `a` and 404s.
	const last = (name.split(/[\\/]/).pop() ?? "").trim().replace(/[#?]/g, "_");
	if (!last || last === "." || last === "..") return "attachment";
	if (last.length <= 255) return last;
	const dot = last.lastIndexOf(".");
	const ext = dot > 0 && last.length - dot <= 16 ? last.slice(dot) : "";
	return last.slice(0, 255 - ext.length) + ext;
}

/** The folder holding one conversation's attachments, relative to the person's prefix. */
const attachmentFolder = (conversationId: string) => `conversations/${conversationId}`;

/**
 * Where one attachment lives, relative to the owner's prefix: the same path for the write here and
 * the read in downloadFile.ts. A long paste lives in the conversation's PASTES_DIRNAME folder, out of
 * My files. Undefined when the name or sha cannot be a path segment.
 */
export function attachmentPath(
	conversationId: string,
	sha: string,
	name: string,
	opts: { paste?: boolean } = {}
): string | undefined {
	const stored = storedName(name);
	if (!stored || !/^[0-9a-f]{64}$/.test(sha)) return undefined;
	const folder = attachmentFolder(conversationId);
	return opts.paste ? `${folder}/${PASTES_DIRNAME}/${sha}/${stored}` : `${folder}/${sha}/${stored}`;
}

/**
 * The key, relative to the owner's prefix, of a message attachment kept in Alpha storage: the path
 * downloadFile.ts reads it from. Undefined for one kept in a linked location, or one whose name or sha
 * cannot be a path. The export and its summary match it against the account's file listing, so one
 * object is not taken once as an attachment and again as a stored file (CUR-3327).
 */
export function storedAttachmentKey(
	conversationId: string,
	ref: Pick<MessageFile, "value" | "name" | "mime" | "location">
): string | undefined {
	if (ref.location) return undefined;
	return attachmentPath(conversationId, ref.value, ref.name, { paste: ref.mime === CLIPBOARD_MIME });
}

/**
 * How long one bucket write may take before its file goes to the files table instead. A healthy write
 * (one listing for the quota, one upload) takes about a second; the Hub client has no timeout of its
 * own, so without this a stalled bucket stalls the turn with it.
 */
const BUCKET_WRITE_TIMEOUT_MS = 8_000;

class BucketWriteTimeoutError extends Error {
	constructor() {
		super(`bucket write took longer than ${BUCKET_WRITE_TIMEOUT_MS} ms`);
		this.name = "BucketWriteTimeoutError";
	}
}

/**
 * `write(signal)`, or a BucketWriteTimeoutError once `ms` pass, aborting the write so it leaves no
 * late, unreferenced copy in the bucket (the file has gone to the files table by then).
 */
function withinDeadline<T>(write: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new BucketWriteTimeoutError());
		}, ms);
	});
	return Promise.race([write(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

/** A short reason for the fallback log line, never the error's message (it can carry a bucket URL). */
function fallbackReason(e: unknown): string {
	if (e instanceof BucketWriteTimeoutError) return "timeout";
	if (e instanceof StorageQuotaExceededError) return "quota";
	if (hubRateLimitedUrl(e)) return "rate_limited";
	return e instanceof Error ? e.name : "unknown";
}

/** Who the bucket keeps this conversation's attachments for, or undefined when they go to the table. */
async function bucketOwner(conv: Conversation): Promise<{ userId: string } | { guestSessionId: string } | undefined> {
	if (!custodialStorageConfigured()) return undefined;
	const userId = conv.userId?.toString();
	if (userId) return (await custodialStorageViewEnabledForUser(userId)) ? { userId } : undefined;
	if (conv.sessionId && custodialStorageForGuestsEnabled()) return { guestSessionId: conv.sessionId };
	return undefined;
}

/**
 * The linked location a signed-in person's chat attachments go to, or undefined for Alpha
 * storage. Their default decides it, as it does for an upload on My files. Chat has no picker, so
 * "Ask every time" means Alpha storage here, and a default whose bucket stopped answering is logged
 * and sends the file to Alpha storage: a broken link never costs the person their turn. (CUR-2930)
 */
export async function linkedAttachmentLocation(
	conv: Conversation,
	email: string | undefined
): Promise<StorageLocation | undefined> {
	const userId = conv.userId?.toString();
	if (!userId || !(await custodialStorageViewEnabledForUser(userId))) return undefined;
	if (!(await storageLocationsEnabledForUser(userId, email))) return undefined;
	try {
		const target = await resolveUploadLocation(userId);
		return target.kind === "alpha" ? undefined : target;
	} catch (e) {
		if (!(e instanceof LocationChoiceRequiredError)) {
			logger.warn(
				{ conversationId: conv._id.toString(), err: e instanceof Error ? e.name : String(e) },
				"[storage-locations] default location unavailable, chat attachments go to Alpha storage"
			);
		}
		return undefined;
	}
}

/**
 * Store a turn's attachments and return the references the message keeps. Sequential, because each
 * write lists the owner's folder to check the quota, and two in parallel would admit against the same
 * listing. The sha is over the file's text decoding, the procedure uploadFile.ts names files by, so a
 * reference reads the same file from either store.
 *
 * A write that fails or passes BUCKET_WRITE_TIMEOUT_MS sends that file to the files table, and every
 * file after it goes straight there, so one stalled bucket costs a turn one deadline, not one per file.
 * @throws StorageQuotaExceededError when a signed-in person's My files is full (CUR-3235), and what the
 * files table throws.
 */
export async function storeChatAttachments(
	conv: Conversation,
	files: { file: File; paste: boolean }[],
	opts: { fault?: FaultInjectionName | null; location?: StorageLocation } = {}
): Promise<MessageFile[]> {
	if (files.length === 0) return [];
	const owner = await bucketOwner(conv);
	if (!owner) return Promise.all(files.map(({ file }) => uploadFile(file, conv)));

	const conversationId = conv._id.toString();
	const started = Date.now();
	const refs: MessageFile[] = [];
	let bucketFailed: string | undefined;
	// A linked location that fails once is skipped for the rest of the turn, like the bucket below.
	let linked = "userId" in owner ? opts.location : undefined;
	let toLinked = 0;
	let toTable = 0;
	for (const { file, paste } of files) {
		// A long paste is message text, never a file the person keeps, so it stays in Alpha storage.
		if (linked && !paste) {
			const name = attachmentName(file.name);
			const sha = await sha256(await file.text());
			try {
				const path = await withinDeadline(
					() => linked!.write(`conversations/${conversationId}/${sha}`, name, file, {}),
					BUCKET_WRITE_TIMEOUT_MS
				);
				refs.push({ type: "hash", value: sha, mime: file.type, name, location: { id: linked.id, path } });
				toLinked++;
				continue;
			} catch (e) {
				logger.warn(
					{ conversationId, reason: fallbackReason(e), ms: Date.now() - started },
					"[storage-locations] chat attachment fell back to Alpha storage"
				);
				linked = undefined;
			}
		}
		if (!bucketFailed) {
			const name = attachmentName(file.name);
			const sha = await sha256(await file.text());
			// Always defined: `name` is a usable segment and `sha` is 64 hex characters.
			const relativePath = attachmentPath(conversationId, sha, name, { paste })!;
			try {
				// Preview-only faults (faultInjection.ts), so a spec can watch the fallback on a live deployment.
				if (opts.fault === "storage_hub_rate_limited") throw hubRateLimitedError("fault injection: storage_hub_rate_limited");
				if (opts.fault === "storage_quota_full") throw new StorageQuotaExceededError(0, 0);
				await withinDeadline((signal) => storeChatAttachment(owner, relativePath, file, { signal }), BUCKET_WRITE_TIMEOUT_MS);
				refs.push({ type: "hash", value: sha, mime: file.type, name });
				continue;
			} catch (e) {
				// A full My files is the person's to sort out, not a failure to route around. The
				// composer checks it when the file is attached, so this is the race between attach and send,
				// and parseRequest refuses the turn with the quota line. A guest still falls back until
				// guests get an attach-time allowance of their own. (CUR-3235)
				if (e instanceof StorageQuotaExceededError && "userId" in owner) throw e;
				bucketFailed = fallbackReason(e);
				logger.warn(
					{ conversationId, owner: "userId" in owner ? "user" : "guest", reason: bucketFailed, ms: Date.now() - started },
					"[custodial] fell back to files table"
				);
			}
		}
		refs.push(await uploadFile(file, conv));
		toTable++;
	}
	logger.info(
		{
			conversationId,
			owner: "userId" in owner ? "user" : "guest",
			stored: refs.length - toTable - toLinked,
			toLinked,
			toTable,
			ms: Date.now() - started,
		},
		"[storage] chat attachments stored"
	);
	return refs;
}
