// The limits a person can hit when they hand the chat a file, in one place, shared by the
// browser and the server so the number in the composer, the number in the refusal and the number the
// server enforces are the same number. Decimal units throughout, the same as `formatBytes`.
//
// WHY THESE NUMBERS. Every chat request runs in a Vercel Function, and "The maximum payload size for
// the request body or the response body of a Vercel Function is 4.5 MB"
// (https://vercel.com/docs/functions/limitations). A request over that is refused by the platform
// before any handler runs, so a limit above it is a promise the product cannot keep. Chat sends its
// attachments inside the message request as base64, which costs 4 bytes for every 3, and they all
// travel together — so the honest chat limit is a total per message, sized so its base64 form plus the
// message itself fits under the platform cap. Raising it means uploading straight to storage,
// bypassing the function body; until then this is the ceiling.
//
// My files uploads one raw file per request, so its per-file cap (custodialUpload.ts) sits just under
// the platform cap itself. (CUR-2631)

import { formatBytes } from "$lib/chat/components/storage/formatBytes";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import {
	CUSTODIAL_MAX_FILES_PER_USER,
	CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
	GUEST_MAX_FILES_PER_SESSION,
	GUEST_MAX_TOTAL_BYTES_PER_SESSION,
} from "$lib/chat/constants/custodialUpload";

/** Vercel's request-body cap for a function, which every upload route sits behind. */
export const PLATFORM_BODY_BYTES = 4_500_000;

/** What a chat request carries besides its attachments: the prompt, history ids, JSON framing. */
export const CHAT_MESSAGE_HEADROOM_BYTES = 300_000;

/** Total raw bytes of the files attached to one chat message. */
export const CHAT_ATTACHMENTS_MAX_BYTES = 3_000_000;

/** Files one chat message may carry, counting long pastes and references to stored files (CUR-3530).
 *  The byte cap above leaves pastes out, so without a count a request under the
 *  body cap could carry hundreds of short pastes, each a storage write on this turn and a read on every
 *  later one. Ten is more than the composer is ever handed in practice. */
export const CHAT_ATTACHMENTS_MAX_COUNT = 10;

/** The files and bytes one identity may attach in chat over a rolling 24 hours, counted in
 *  both stores. My files' quota bounds the bucket, but a write the bucket fails goes to the files
 *  table, which nothing else limits. The guest numbers are the guest session's storage tier; an (CUR-3235)
 *  account gets My files' total. Long pastes are message text and never count. */
export const ATTACHMENT_ALLOWANCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** What every guest session on one network may attach between them in the same 24 hours.
 *  A guest who clears cookies is minted a new session and a fresh guest allowance; this bounds that
 *  by network, the same backstop chat messages have (rateLimit.ts). Sized for a room, not a person:
 *  a few hundred visitors behind one event's Wi-Fi each attaching once stay under 500. Lower it and (CUR-3600)
 *  an event trips it; raise it and one address can fill the files table faster. */
const ATTACHMENT_ALLOWANCE_NETWORK_MULTIPLIER = 50;
export const ATTACHMENT_ALLOWANCE = {
	account: { files: 100, bytes: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER },
	guest: { files: GUEST_MAX_FILES_PER_SESSION, bytes: GUEST_MAX_TOTAL_BYTES_PER_SESSION },
	guestNetwork: {
		files: GUEST_MAX_FILES_PER_SESSION * ATTACHMENT_ALLOWANCE_NETWORK_MULTIPLIER,
		bytes: GUEST_MAX_TOTAL_BYTES_PER_SESSION * ATTACHMENT_ALLOWANCE_NETWORK_MULTIPLIER,
	},
} as const;

/** How long until the allowance frees up, as a person would say it. */
function resetsIn(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The sentence a file is refused with when the identity's 24-hour allowance has no room for it, at
 *  attach and at send. `resetsInMs` is until the oldest counted file stops counting. `network`: the
 *  guests on this network have spent theirs between them, which at an event is the room, not the
 *  person, so the line says so. */
export function attachmentAllowanceMessage(opts: { guest: boolean; network?: boolean; resetsInMs: number }): string {
	const when = `You can attach more ${resetsIn(opts.resetsInMs)}.`;
	if (opts.guest && opts.network)
		return `Too many files have been attached from your network today. If you're at an event sharing Wi-Fi, sign in to attach more, or ${when.charAt(0).toLowerCase()}${when.slice(1)}`;
	return opts.guest
		? `You've attached as many files as a guest can in a day. ${when} Sign in for a larger allowance.`
		: `You've attached as many files as Alpha takes in a day. ${when}`;
}

/** The share of the 24-hour allowance, in files or in bytes, at or below which the composer (CUR-3235)
 *  says how much is left, so the refusal is never the first a person hears of the limit. */
const ATTACHMENT_ALLOWANCE_WARN_SHARE = 0.2;

/** The quiet line under the composer's files once what is left of the allowance is at or below
 *  `ATTACHMENT_ALLOWANCE_WARN_SHARE` of `limit` in files or in bytes, or undefined above it. `left` is
 *  what remains after the files on the composer. A spent allowance gets no line here; the refusal says it. */
export function attachmentAllowanceNearMessage(opts: {
	left: { files: number; bytes: number };
	limit: { files: number; bytes: number };
	guest: boolean;
	resetsInMs: number;
}): string | undefined {
	const { left, limit } = opts;
	if (left.files < 1 || left.bytes < 1) return undefined;
	const near =
		left.files <= limit.files * ATTACHMENT_ALLOWANCE_WARN_SHARE ||
		left.bytes <= limit.bytes * ATTACHMENT_ALLOWANCE_WARN_SHARE;
	if (!near) return undefined;
	const more = `You can attach ${left.files} more file${left.files === 1 ? "" : "s"} today, up to ${formatBytes(left.bytes)}.`;
	const frees = opts.resetsInMs > 0 ? ` More frees up ${resetsIn(opts.resetsInMs)}.` : "";
	return opts.guest ? `${more}${frees} Sign in for a larger allowance.` : `${more}${frees}`;
}

/** The sentence a message over the file count is refused with. */
export function chatAttachmentsTooManyMessage(): string {
	return `A message can carry up to ${CHAT_ATTACHMENTS_MAX_COUNT} files. Remove some or send them in a separate message.`;
}

/** One voice recording sent for transcription, as raw audio in the request body. */
export const VOICE_RECORDING_MAX_BYTES = 4_400_000;

/** Bytes a body of `raw` bytes occupies once base64-encoded. */
export function base64Bytes(raw: number): number {
	return Math.ceil(raw / 3) * 4;
}

/** The one sentence every chat surface shows when a message's attachments are over the limit. */
export function chatAttachmentsTooLargeMessage(): string {
	return `Attachments can add up to ${formatBytes(CHAT_ATTACHMENTS_MAX_BYTES)} per message. Remove a file or send it in a separate message.`;
}

/** The sentence voice input shows when a recording is over the limit. */
export function voiceRecordingTooLargeMessage(): string {
	return `Recordings can be up to ${formatBytes(VOICE_RECORDING_MAX_BYTES)}. Record a shorter message.`;
}

/** The sentence a file is refused with when My files has no room for it, when it is (CUR-3235)
 *  attached and again if the send finds the account full. */
export function myFilesFullMessage(): string {
	return `Your files are full (${formatBytes(CUSTODIAL_MAX_TOTAL_BYTES_PER_USER)}). Delete a file in My files to attach this one.`;
}

/** What My files can still take: files and bytes under the account's limits. */
export type MyFilesHeadroom = { files: number; bytes: number };

/** One limit a file headed for storage must fit, with the line it is refused with. With no `refusal`
 *  it is My files' headroom, refused with `myFilesFullMessage`. `warning`, given what the room has
 *  left once the composer's files are counted, is the line to show while there is still room. */
export type AttachmentRoom = MyFilesHeadroom & {
	refusal?: string;
	warning?: (left: MyFilesHeadroom) => string | undefined;
};

/** The headroom left by a My files listing (`GET /chat/api/storage`), which leaves pastes out as the
 *  quota does. Never below zero. */
export function myFilesHeadroom(listing: readonly { size: number }[]): MyFilesHeadroom {
	const used = listing.reduce((sum, f) => sum + f.size, 0);
	return {
		files: Math.max(0, CUSTODIAL_MAX_FILES_PER_USER - listing.length),
		bytes: Math.max(0, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER - used),
	};
}

/**
 * Which of `incoming` fit alongside `existing` under the per-message limit, in order, and the refusal
 * to show for any that don't. Every path that adds a file to the composer (drop, paste, picker, URL
 * fetch) goes through this, so none of them can admit what the server will refuse.
 */
export function admitAttachments(
	existing: readonly { size: number; type?: string }[],
	incoming: readonly File[],
	rooms?: AttachmentRoom | readonly AttachmentRoom[]
): { admitted: File[]; refusal?: string; warning?: string } {
	let used = existing.reduce((sum, f) => sum + f.size, 0);
	// Each known room (My files' headroom, the 24-hour allowance) counts every file headed for
	// storage, including the ones already waiting on the composer. A long paste is message text and
	// never counts. (CUR-3235)
	const kept = existing.filter((f) => f.type !== CLIPBOARD_MIME);
	const keptBytes = kept.reduce((sum, f) => sum + f.size, 0);
	const left = (rooms === undefined ? [] : Array.isArray(rooms) ? rooms : [rooms as AttachmentRoom]).map((r) => ({
		files: r.files - kept.length,
		bytes: r.bytes - keptBytes,
		refusal: r.refusal ?? myFilesFullMessage(),
		warning: r.warning,
	}));
	const admitted: File[] = [];
	let refusal: string | undefined;
	for (const file of incoming) {
		if (used + file.size > CHAT_ATTACHMENTS_MAX_BYTES) {
			refusal ??= chatAttachmentsTooLargeMessage();
			continue;
		}
		const stored = file.type !== CLIPBOARD_MIME;
		const full = stored ? left.find((r) => r.files < 1 || file.size > r.bytes) : undefined;
		if (full) {
			refusal = full.refusal;
			continue;
		}
		used += file.size;
		if (stored) {
			for (const r of left) {
				r.files -= 1;
				r.bytes -= file.size;
			}
		}
		admitted.push(file);
	}
	if (refusal) return { admitted, refusal };
	// The first room close to its limit says so once the files on the composer are counted.
	for (const r of left) {
		const warning = r.warning?.({ files: r.files, bytes: r.bytes });
		if (warning) return { admitted, warning };
	}
	return { admitted };
}

/** Guests cannot attach files: where sign-in is offered, the composer asks for it and the server
 *  refuses a guest's attachment with this line. */
export const SIGN_IN_TO_ATTACH_MESSAGE = "Sign in to attach files.";
/** Guests cannot use agent mode: the server refuses a guest's agent turn with this line (CUR-4400). */
export const SIGN_IN_TO_USE_AGENT_MESSAGE = "Sign in to use agent mode.";
