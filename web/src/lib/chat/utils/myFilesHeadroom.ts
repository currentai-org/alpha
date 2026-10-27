import { page } from "$app/state";
import { base } from "$lib/chat/paths";
import {
	ATTACHMENT_ALLOWANCE,
	attachmentAllowanceMessage,
	attachmentAllowanceNearMessage,
	CHAT_ATTACHMENTS_MAX_BYTES,
	CHAT_ATTACHMENTS_MAX_COUNT,
	myFilesHeadroom,
	type AttachmentRoom,
	type MyFilesHeadroom,
} from "$lib/chat/constants/uploadLimits";
import { checkingRoom } from "$lib/chat/utils/shrinkImage";

/** How long the composer waits on My files' listing before letting the file through unchecked. */
const LISTING_TIMEOUT_MS = 4_000;

/** How long a roomy headroom is reused before the next attach lists My files again.
 *  @internal exported for its unit tests */
export const HEADROOM_REUSE_MS = 60_000;

/**
 * Room for two full messages. One may have been stored since the read, and the one being
 * written still fits, so reusing it never refuses a file. A smaller headroom is listed again, so a
 * refusal always comes from a fresh listing. (CUR-3681)
 */
function roomy(room: MyFilesHeadroom): boolean {
	return room.files >= 2 * CHAT_ATTACHMENTS_MAX_COUNT && room.bytes >= 2 * CHAT_ATTACHMENTS_MAX_BYTES;
}

let lastRead: { at: number; room: MyFilesHeadroom } | undefined;
let inFlight: Promise<MyFilesHeadroom | undefined> | undefined;

/** Forget the reused headroom. My files calls it after an upload, delete or transfer, so the next
 *  attach lists the files as they now are. */
export function myFilesChanged(): void {
	lastRead = undefined;
	inFlight = undefined;
}

async function listMyFilesHeadroom(): Promise<MyFilesHeadroom | undefined> {
	try {
		const res = await fetch(`${base}/api/storage`, { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
		if (!res.ok) return undefined;
		const { files } = (await res.json()) as { files?: { size: number }[] };
		if (!Array.isArray(files)) return undefined;
		const room = myFilesHeadroom(files);
		lastRead = { at: Date.now(), room };
		return room;
	} catch {
		return undefined;
	}
}

/**
 * What My files can still take, for the composer to check a file against when it is attached,
 * or undefined when there is nothing to check: no My files for this visitor, or a listing that failed
 * or was slow. Undefined lets the file through, and the send refuses it if the account really is full.
 * Read through `fetchAttachmentRooms`, the composer's entry point.
 * (CUR-3235)
 * The listing is a recursive Hugging Face call on a token every visitor shares, so a roomy
 * headroom read in the last minute is reused, and attaches that land together share one listing. (CUR-3681)
 */
async function fetchMyFilesHeadroom(): Promise<MyFilesHeadroom | undefined> {
	if (!page.data.storageViewEnabled) return undefined;
	if (lastRead && Date.now() - lastRead.at < HEADROOM_REUSE_MS && roomy(lastRead.room)) return lastRead.room;
	inFlight ??= listMyFilesHeadroom().finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

/**
 * What this visitor can still attach over the rolling 24 hours, or undefined when the count
 * failed or was slow. The send checks the same allowance, so undefined only moves the refusal later. (CUR-3235)
 */
async function fetchAttachmentAllowance(): Promise<AttachmentRoom | undefined> {
	try {
		const res = await fetch(`${base}/api/attachment-allowance`, { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
		if (res.status !== 200) return undefined;
		const left = (await res.json()) as {
			files: number;
			bytes: number;
			guest: boolean;
			network?: boolean;
			resetsInMs?: number;
		};
		const resetsInMs = left.resetsInMs ?? 0;
		const limit = !left.guest
			? ATTACHMENT_ALLOWANCE.account
			: left.network
				? ATTACHMENT_ALLOWANCE.guestNetwork
				: ATTACHMENT_ALLOWANCE.guest;
		return {
			files: left.files,
			bytes: left.bytes,
			refusal: attachmentAllowanceMessage({ guest: left.guest, network: left.network, resetsInMs }),
			warning: (after) => attachmentAllowanceNearMessage({ left: after, limit, guest: left.guest, resetsInMs }),
		};
	} catch {
		return undefined;
	}
}

/**
 * Every limit a file attached now must fit before it reaches storage: My files' headroom and the
 * 24-hour allowance, each left out when unknown. Start it before `shrinkImages` and await it after, so
 * the send keeps holding the files from the moment they are chosen until they reach the composer
 * (`checkingRoom`; an Enter in between would send the text without the photo):
 * `const room = fetchAttachmentRooms(); const ready = await shrinkImages(picked);
 *  const rooms = await room; files = addAttachments(files, ready, rooms);`
 * Await it on its own line: `addAttachments(files, ready, await room)` reads `files` before suspending,
 * so a file attached meanwhile is overwritten.
 */
export async function fetchAttachmentRooms(): Promise<AttachmentRoom[]> {
	checkingRoom.update((n) => n + 1);
	try {
		const rooms = await Promise.all([fetchMyFilesHeadroom(), fetchAttachmentAllowance()]);
		return rooms.filter((r): r is AttachmentRoom => r !== undefined);
	} finally {
		checkingRoom.update((n) => n - 1);
	}
}
