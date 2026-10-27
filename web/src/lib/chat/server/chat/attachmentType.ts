import {
	CLIPBOARD_MIME,
	DOCUMENT_MIME_ALLOWLIST,
	IMAGE_MIME_RENDERABLE,
	TEXT_MIME_ALLOWLIST,
} from "$lib/chat/constants/mime";

/** Chat's line for a file whose type the composer never offers: an archive, a program, a spreadsheet. */
export const FILE_TYPE_NOT_ACCEPTED_MESSAGE = "This kind of file can't be added here, so it wasn't added.";

const BARE_MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** Wildcard mime match against TEXT_MIME_ALLOWLIST. */
export function isTextMime(mime: string): boolean {
	const [fileType, fileSubtype] = (mime || "").toLowerCase().split("/");
	return TEXT_MIME_ALLOWLIST.some((allowed) => {
		const [type, subtype] = allowed.toLowerCase().split("/");
		const typeOk = type === "*" || type === fileType;
		const subOk = subtype === "*" || subtype === fileSubtype;
		return typeOk && subOk;
	});
}

/**
 * The type a chat attachment is stored under, or null when chat does not take it (CUR-3832). Pass the
 * type sniffed from the bytes, with the declared one only as the fallback for text.
 *
 * Accepted are the types the composer offers: JPEG, PNG, WebP and GIF (it redraws an AVIF or BMP as
 * JPEG first), the text allowlist, PDF and Word, and a long paste. An archive or a program would be
 * stored without a scan, since `scanTargetForMime` has nothing to check it with, and an SVG or TIFF
 * would be rendered in this function to be checked. A text type comes back bare, parameters cut, or
 * as `text/plain` when what is left is not a plain `type/subtype`, because it is written into the
 * prompt's `<document type="…">` wrapper unescaped.
 */
export function acceptedAttachmentType(mime: string): string | null {
	const bare = (mime || "").toLowerCase().split(";")[0].trim();
	if (bare === CLIPBOARD_MIME) return bare;
	if ((DOCUMENT_MIME_ALLOWLIST as readonly string[]).includes(bare)) return bare;
	if ((IMAGE_MIME_RENDERABLE as readonly string[]).includes(bare)) return bare;
	if (bare.startsWith("text/")) return BARE_MIME.test(bare) ? bare : "text/plain";
	if (isTextMime(bare)) return bare;
	return null;
}
