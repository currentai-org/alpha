import { m } from '$lib/paraglide/messages.js';
// The limits custodial storage ships with. Shared (client + server) and free of
// server-only imports, the same way `ragUpload.ts` is, so an upload UI and the server enforce one
// set of numbers rather than two that drift. Client checks are UX feedback only — every value here
// is re-checked server-side in `custodialStorage.ts` against the real bytes and a real listing,
// because a picker's opinion about a file is not evidence.
//
// WHY 4.4 MB AND NOT THE 20 MB IN THE DESIGN. Vercel caps a serverless function's REQUEST BODY at
// 4.5 MB. A file larger than that fails at the platform layer before any handler runs, so a bigger
// number here would be a promise the product cannot keep — the person would see a limit of 20 MB and
// an unexplained failure at 5. `ragUpload.ts` already carries this constraint for the admin path and
// names the escape hatch: a direct-to-blob upload that bypasses the function body entirely. Until
// that exists, 4.4 MB is the honest ceiling and the design's 20 MB placeholder cannot ship as drawn. (CUR-1129)

import { formatBytes } from "$lib/chat/components/storage/formatBytes";
import type { UploadKind } from "$lib/chat/constants/ragUpload";
import { CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE } from "./chunkedUpload";

/** Per-file ceiling. Bounded by Vercel's 4.5 MB request body, not by policy — see the note above. */
export const CUSTODIAL_MAX_BYTES_PER_FILE = 4_400_000;

// The chunked ceiling and chunk size live in ./chunkedUpload, which imports nothing, so the
// chunk store and the cleanup cron can read them outside Vite. (CUR-1780)
export { CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE, CUSTODIAL_UPLOAD_CHUNK_BYTES } from "./chunkedUpload";

/** The per-file ceiling for whichever upload path this account has. */
export function custodialMaxBytesPerFile(chunked: boolean): number {
	return chunked ? CUSTODIAL_MAX_BYTES_PER_CHUNKED_FILE : CUSTODIAL_MAX_BYTES_PER_FILE;
}

/** Per-person file count. Also bounds the cost of the listing every upload does to check the quota. */
export const CUSTODIAL_MAX_FILES_PER_USER = 200;

/** Per-person total bytes. The actual quota; the count cap above is a guard on listing cost. */
export const CUSTODIAL_MAX_TOTAL_BYTES_PER_USER = 250_000_000;

/** A guest's chat attachments, per session (CUR-2183; the tier CUR-2631 sets: 25 MB, 10 files). Small,
 * because a guest's files expire 30 days after upload and exist for the conversation, not for
 * keeping: sign in for My files' quota. */
export const GUEST_MAX_FILES_PER_SESSION = 10;
export const GUEST_MAX_TOTAL_BYTES_PER_SESSION = 25_000_000;

/** Share of either cap at which My files starts warning, so the first refusal is never a surprise. */
const STORAGE_WARN_FRACTION = 0.8;

/**
 * How full someone's storage is, against whichever cap is closer, plus the sentence My files shows
 * once that passes `STORAGE_WARN_FRACTION` (CUR-2631). Undefined below it: a meter that nags at 10%
 * teaches people to ignore it.
 */
export function storageUsage(
	usedBytes: number,
	fileCount: number,
): { fraction: number; warning?: string } {
	const byBytes = usedBytes / CUSTODIAL_MAX_TOTAL_BYTES_PER_USER;
	const byFiles = fileCount / CUSTODIAL_MAX_FILES_PER_USER;
	const fraction = Math.min(1, Math.max(byBytes, byFiles));
	if (fraction < STORAGE_WARN_FRACTION) return { fraction };
	const filesBind = byFiles > byBytes;
	if (fraction >= 1)
		return {
			fraction,
			warning: filesBind
				? m.storage_fileLimitReached({ count: CUSTODIAL_MAX_FILES_PER_USER })
				: m.storage_full(),
		};
	return {
		fraction,
		warning: filesBind
			? m.storage_filesUsed({ count: fileCount, max: CUSTODIAL_MAX_FILES_PER_USER })
			: m.storage_percentUsed({ percent: Math.floor(fraction * 100) }),
	};
}

/** What a person reads when the storage host throttles the storage token (CUR-3120). */
export const STORAGE_BUSY_MESSAGE = "Storage is busy right now. Try again in a minute.";
/** A chat's files go before the chat does, so a throttled bucket keeps the whole chat. (CUR-3666) */
export const CHAT_DELETE_BUSY_MESSAGE = "Storage is busy right now, so this chat wasn't deleted. Try again in a minute.";
/** Forget everything and Delete account wipe the files first, so a throttled bucket clears nothing. (CUR-3680) */
export const WIPE_BUSY_MESSAGE = "Storage is busy right now, so nothing was cleared. Try again in a few minutes.";

/**
 * The sentence My files shows when the server refuses an upload, keyed by the status the storage
 * guard maps each typed error to (`routes/chat/api/storage/guard.ts`). Each one names the limit and
 * what to do next (CUR-2631). `retryAfterSeconds` comes from the 429's `Retry-After` header.
 */
export function storageRefusalMessage(
	status: number,
	fallback: string,
	retryAfterSeconds?: number,
	// The ceiling this account's uploads have, so a 413 names the limit it was held to. (CUR-1780)
	perFileLimit: number = CUSTODIAL_MAX_BYTES_PER_FILE,
): string {
	switch (status) {
		case 413:
			return m.storage_tooLarge({ limit: formatBytes(perFileLimit) });
		case 415:
			return m.storage_unsupportedType();
		case 429: {
			const minutes = retryAfterSeconds ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : undefined;
			const wait = minutes
				? minutes === 1
					? m.storage_tryAgainOneMinute()
					: m.storage_tryAgainMinutes({ minutes })
				: m.storage_tryAgainShortly();
			return `${m.storage_hourlyLimit({ count: CUSTODIAL_UPLOADS_PER_HOUR })} ${wait}`;
		}
		case 507:
			return m.storage_fullWithSize({ size: formatBytes(CUSTODIAL_MAX_TOTAL_BYTES_PER_USER) });
		// Each 422 is a different content refusal (too many pictures, a picture we couldn't
		// check, a known-abuse match) and the server's line names which, so show it. The generic line
		// is only for a 422 that arrived with no message. (CUR-4662)
		case 422:
			return fallback || m.storage_cantStore();
		// Two causes answer 503: the scanner being unavailable, and the storage host throttling our token (CUR-3120).
		case 503:
			return fallback === STORAGE_BUSY_MESSAGE ? STORAGE_BUSY_MESSAGE : m.storage_scanUnavailable();
		default:
			return fallback || m.storage_uploadFailedStatus({ status });
	}
}

/**
 * Whether a refused upload's row offers "Try again" or only "Remove". The same file sent again gets
 * the same answer for a size, a type or a content refusal, so those rows offer no retry (CUR-2450).
 * A full store (507) can take the file once something is deleted, so it keeps the retry.
 */
export function storageRefusalRecovery(status: number): "retry" | "remove" {
	return status === 413 || status === 415 || status === 422 ? "remove" : "retry";
}

/** Uploads one person may start per hour. A civility limit, not a security boundary — see
 *  `custodialStorage.ts` on why an in-memory counter is a backstop rather than a guarantee. */
export const CUSTODIAL_UPLOADS_PER_HOUR = 60;
export const CUSTODIAL_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * What a person may store. Deliberately NARROWER than the RAG admin path's list: this is a
 * general-purpose file store a stranger uploads to, so the set is the one the design actually
 * shows (PDF, DOCX, TXT, CSV, PNG/JPG) rather than everything the extractor happens to parse.
 * Enforced from a magic-byte sniff, never from the filename — see `resolveUploadKind`.
 */
export const CUSTODIAL_ALLOWED_KINDS: readonly UploadKind[] = [
	"text",
	"markdown",
	"csv",
	"pdf",
	"docx",
	"image",
] as const;

// The picker `accept` string and a human-readable formats label belong to the upload UI (CUR-1113),
// not here: an exported constant with no consumer is dead code the knip gate refuses, and the UI's
// wording would otherwise live in a second place.
