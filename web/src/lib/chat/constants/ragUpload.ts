// Shared (client + server) config for the RAG admin file-upload feature. This module has NO
// server-only imports so BOTH the FileDropZone component and the /tuning/rag/upload endpoint import
// it — the accept list, size caps, and file-kind mapping live in ONE place. Client checks are for
// UX feedback only; the server re-sniffs and re-validates every byte (never trust the picker).

export type UploadKind = "text" | "markdown" | "csv" | "json" | "html" | "pdf" | "docx" | "image";

/**
 * Photo types the known-abuse scanner (HMA) cannot hash: it answers HTTP 500 to a HEIC, and the
 * server's sharp build has no HEVC decoder to convert one. My files redraws these as JPEG in the
 * browser before upload, and the server refuses one it is still handed as an unsupported type rather
 * than as a scanner outage, which a retry could never clear (CUR-4665).
 */
export const SCANNER_UNREADABLE_IMAGE_MIMES: readonly string[] = [
	"image/heic",
	"image/heif",
	"image/heic-sequence",
	"image/heif-sequence",
];

/** OS file-picker filter. A hint only — the server re-derives the kind from the sniffed bytes. */
export const UPLOAD_ACCEPT =
	".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.ndjson,.html,.htm,.pdf,.docx,image/*";

/** Human-readable list of supported formats (UI helper text). */
export const SUPPORTED_FORMATS_LABEL =
	"text, Markdown, CSV/TSV, JSON/JSONL, HTML, PDF, DOCX, and images (PNG/JPG/WebP/GIF)";

/** Hard cap on files staged per batch (bounds the client list and the server-side fan-out). */
export const MAX_UPLOAD_FILES = 20;

// NOTE: Vercel serverless functions cap the REQUEST BODY at 4.5 MB. One file per POST plus multipart
// envelope overhead must stay under that, so every cap below is ≤ 4 MB and the absolute ceiling is
// 4.4 MB. Larger files would fail at the platform layer before reaching the handler — keep these in
// sync with that limit (and use direct-to-blob upload if bigger files are ever needed).

/** Absolute byte ceiling regardless of kind — stays under the Vercel 4.5 MB request-body cap. */
export const UPLOAD_MAX_BYTES_ANY = 4_400_000;

/** Pages a PDF may have before it is refused unread. Extraction cost grows faster than page count: a
 *  1.2 MB file of 10,000 blank pages takes about 10 s, 30,000 exhaust node's memory, and 1,000 take
 *  about a quarter of a second (CUR-3837). */
export const MAX_PDF_PAGES = 1_000;

/** Per-kind byte caps (server-enforced; client mirrors for instant feedback). All ≤ 4 MB. */
export const UPLOAD_MAX_BYTES: Record<UploadKind, number> = {
	text: 4_000_000,
	markdown: 4_000_000,
	csv: 4_000_000,
	json: 4_000_000,
	html: 4_000_000,
	pdf: 4_000_000,
	docx: 4_000_000,
	image: 4_000_000,
};

const EXT_KIND: Record<string, UploadKind> = {
	txt: "text",
	text: "text",
	log: "text",
	md: "markdown",
	markdown: "markdown",
	mdown: "markdown",
	csv: "csv",
	tsv: "csv",
	json: "json",
	jsonl: "json",
	ndjson: "json",
	html: "html",
	htm: "html",
	pdf: "pdf",
	docx: "docx",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "avif"]);

/** Lower-cased file extension without the dot ("" when there is none). */
export function extensionOf(name: string): string {
	const m = /\.([a-z0-9]+)$/i.exec((name || "").trim());
	return m ? m[1].toLowerCase() : "";
}

/** A clean display title from a filename: drop the extension, turn separators into spaces. */
export function titleFromFilename(name: string): string {
	const base = (name || "")
		.replace(/\.[^./\\]+$/, "")
		.replace(/[._]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return base || (name || "").trim() || "Untitled";
}

/** Classify by MIME ALONE, ignoring the filename. Used server-side on a magic-byte sniff so a
 *  renamed binary (e.g. an .exe called "photo.png") can't be reinterpreted via its spoofable
 *  extension. Returns null for unsupported/undetectable mimes. */
export function classifyByMime(mime: string | undefined): UploadKind | null {
	const m = (mime || "").toLowerCase().split(";")[0].trim();
	if (!m) return null;
	if (m.startsWith("image/")) return "image";
	if (m === "application/pdf") return "pdf";
	if (m.includes("wordprocessingml")) return "docx";
	if (m === "text/csv" || m === "text/tab-separated-values") return "csv";
	if (m === "application/json" || m === "application/x-ndjson" || m === "application/jsonl")
		return "json";
	if (m === "text/html") return "html";
	if (m === "text/markdown") return "markdown";
	if (m.startsWith("text/")) return "text";
	return null;
}

/** Best-effort kind from filename + a declared/sniffed mime. Returns null for unsupported types. */
export function classifyUpload(name: string, mime: string | undefined): UploadKind | null {
	const m = (mime || "").toLowerCase().split(";")[0].trim();
	if (m.startsWith("image/")) return "image";
	const ext = extensionOf(name);
	if (IMAGE_EXTS.has(ext)) return "image";
	if (EXT_KIND[ext]) return EXT_KIND[ext];
	// Fall back to the mime when the extension is missing or unrecognized.
	if (m === "application/pdf") return "pdf";
	if (m.includes("wordprocessingml")) return "docx";
	if (m === "text/csv" || m === "text/tab-separated-values") return "csv";
	if (m === "application/json" || m === "application/x-ndjson" || m === "application/jsonl")
		return "json";
	if (m === "text/html") return "html";
	if (m === "text/markdown") return "markdown";
	if (m.startsWith("text/")) return "text";
	return null;
}
