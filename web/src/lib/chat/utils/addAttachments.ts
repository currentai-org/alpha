import { writable } from "svelte/store";
import { admitAttachments, type AttachmentRoom } from "$lib/chat/constants/uploadLimits";

/**
 * The composer's files with `incoming` added, keeping only what fits the per-message limit
 * (CUR-2631). A refusal goes to the chat's error banner with the same sentence the server sends, so a
 * file the server would refuse never sits in the composer looking accepted.
 *
 * Pass `incoming` through `shrinkImages` first (CUR-2633), and read the composer's files only after
 * that await, so two quick adds can't overwrite each other:
 * `const ready = await shrinkImages(picked); files = addAttachments(files, ready);`
 *
 * `rooms` come from `fetchAttachmentRooms` (CUR-3235): My files' headroom and the 24-hour allowance. A
 * file that won't fit one is refused the same way, with that room's line.
 */
export function addAttachments(files: File[], incoming: File[], rooms?: readonly AttachmentRoom[]): File[] {
	const { admitted, refusal, warning } = admitAttachments(files, incoming, rooms);
	// A refusal belongs to the message being written, so it is said on the composer (attachmentRefusal),
	// not in the app-wide toast; a file that does fit clears an earlier one.
	if (refusal) attachmentRefusal.set({ message: refusal });
	else if (admitted.length > 0) attachmentRefusal.set(undefined);
	attachmentWarning.set(warning);
	return [...files, ...admitted];
}

/** How much of the 24-hour allowance is left, once it is close to spent, for the line under (CUR-3235)
 *  the composer's files. Set by every add; the composer clears it when its files are sent or removed. */
export const attachmentWarning = writable<string | undefined>(undefined);

/** Why the composer just refused a file (type, size, allowance, a photo the model can't read). Shown as a
 *  notice on the composer's top edge until dismissed, a file is accepted, the model changes or a send. */
export const attachmentRefusal = writable<AttachmentRefusal | undefined>(undefined);

/** What was refused, and the one thing that fixes it where there is one: sign in (a guest), or pick a
 *  model that reads photos. */
export interface AttachmentRefusal {
	message: string;
	fix?: "sign-in" | "photo-model";
}
