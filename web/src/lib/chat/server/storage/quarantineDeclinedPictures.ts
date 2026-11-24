// A chat picture is stored before its turn is screened (attachmentsToCustodial.ts), so a turn the
// screen declines for child safety would otherwise leave the picture in the sender's My files, where
// they could list, open, download and attach it again. The copy is kept for review, and the
// sender loses every way to reach it: it moves into the owner's quarantine folder, the evidence store
// My files uploads already use (custodialStorage.ts screenUpload), which no listing, read, download,
// delete, sweep, wipe or sign-in move reaches. The files table's copy (a bucket write that timed out)
// moves there too, and the sent message keeps the file only by name, as a left-out file, so neither the
// reopened chat nor its old output URL serves it.
//
// What this store does not do yet: there is no reporting step, so nothing sends a quarantined picture
// to a reviewer or an authority, and there is no retention limit, so nothing deletes it. Who reviews
// it, how it is reported and how long it is kept are the trust-and-safety lead's decisions, still open.

import { fileTypeFromBuffer } from "file-type";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import { logger } from "$lib/chat/server/logger";
import { deleteFileByFilename, getFileByFilename } from "$lib/chat/server/db/files";
import { attachmentPath } from "./attachmentsToCustodial";
import {
	custodialStorageConfigured,
	quarantineAttachmentBytes,
	quarantineChatAttachment,
	type AttachmentOwnerRef,
} from "./custodialStorage";

/** The rules whose decline takes the turn's pictures out of the sender's reach. */
const PICTURE_EVIDENCE_RULES: ReadonlySet<string> = new Set([
	"chat-block-child-sexual-content",
	"chat-block-child-grooming",
]);

/**
 * Whether a decline moves the turn's pictures. Only a child-safety rule the screen actually fired:
 * a screen that could not answer (`unscreened`) declines too, and that case is left as it was.
 */
export function declineQuarantinesPictures(decline: {
	kind: string;
	auditCategory?: string;
	unscreened?: boolean;
}): boolean {
	return (
		decline.kind === "child_safety" &&
		!decline.unscreened &&
		decline.auditCategory !== undefined &&
		PICTURE_EVIDENCE_RULES.has(decline.auditCategory)
	);
}

async function isPicture(content: Blob): Promise<boolean> {
	const head = new Uint8Array(await content.slice(0, 4100).arrayBuffer());
	return (await fileTypeFromBuffer(head))?.mime.startsWith("image/") ?? false;
}

/** Every folder a conversation's attachment can sit under, in the order downloadFile.ts reads them. */
function ownersOf(conv: Pick<Conversation, "userId" | "sessionId" | "formerGuestSessionId">): AttachmentOwnerRef[] {
	const userId = conv.userId?.toString();
	if (userId) return [{ userId }, ...(conv.formerGuestSessionId ? [{ guestSessionId: conv.formerGuestSessionId }] : [])];
	return conv.sessionId ? [{ guestSessionId: conv.sessionId }] : [];
}

/**
 * Moves every picture on the declined `question` into quarantine and marks it left out on the message,
 * which the caller persists with the turn. A file kept in a location the person linked, a paste, and a
 * file that is not a picture are left as they are. A move that fails is logged and leaves that file
 * where it was, never deleted without its copy.
 * @returns the quarantine paths, for the decline's safety_events row.
 */
export async function quarantineDeclinedPictures(
	conv: Pick<Conversation, "_id" | "userId" | "sessionId" | "formerGuestSessionId">,
	question: Message
): Promise<string[]> {
	const conversationId = conv._id.toString();
	const owners = ownersOf(conv);
	const evidence: string[] = [];
	const moved = new Set<string>();
	for (const ref of question.files ?? []) {
		if (ref.location || ref.mime === CLIPBOARD_MIME || ref.type !== "hash") continue;
		const relativePath = attachmentPath(conversationId, ref.value, ref.name, { agentTurn: ref.agentTurn });
		try {
			let kept: string | null = null;
			if (relativePath && custodialStorageConfigured()) {
				for (const owner of owners) {
					const path = await quarantineChatAttachment(owner, relativePath, isPicture);
					if (path) {
						kept ??= path;
						evidence.push(path);
					}
				}
			}
			// The files table holds a copy when the bucket write timed out, and is read when the bucket has none.
			const filename = `${conversationId}-${ref.value}`;
			const row = await getFileByFilename(filename, conversationId);
			if (row && owners[0] && custodialStorageConfigured()) {
				const bytes = new Blob([new Uint8Array(row.data)]);
				if (kept || (await isPicture(bytes))) {
					if (!kept) {
						kept = await quarantineAttachmentBytes(owners[0], ref.name, bytes);
						evidence.push(kept);
					}
					await deleteFileByFilename(filename, conversationId);
				}
			}
			if (kept) moved.add(ref.value);
		} catch (e) {
			logger.error(
				{ conversationId, err: e instanceof Error ? e.name : String(e) },
				"[safety] a child-safety decline's picture could not be moved to quarantine; it is still in the sender's files"
			);
		}
	}
	if (moved.size > 0) {
		const left = (question.files ?? []).filter((f) => moved.has(f.value));
		question.files = (question.files ?? []).filter((f) => !moved.has(f.value));
		question.leftOutFiles = [...(question.leftOutFiles ?? []), ...left.map((f) => ({ name: f.name, mime: f.mime }))];
	}
	return evidence;
}
