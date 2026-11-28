// Shared (client + server) config for the RAG admin file-upload feature. This module has NO
// server-only imports so BOTH the FileDropZone component and the /tuning/rag/upload endpoint import
// it — the accept list, size caps, and file-kind mapping live in ONE place. Client checks are for
// UX feedback only; the server re-sniffs and re-validates every byte (never trust the picker).

export type UploadKind =
	| "text"
	| "markdown"
	| "csv"
	| "json"
	| "html"
	| "pdf"
	| "docx"
	| "image"
	// CUR-4664: kinds My files stores that the RAG admin path does not read to text (RAG_UPLOAD_KINDS).
	| "xlsx"
	| "pptx"
	| "odt"
	| "ods"
	| "odp"
	| "rtf"
	| "epub";

/** The kinds the RAG admin upload reads to text or captions. The rest of UploadKind is stored by My
 *  files but has no extractor here, so the admin route refuses it as unsupported. */
export const RAG_UPLOAD_KINDS: readonly UploadKind[] = ["text", "markdown", "csv", "json", "html", "pdf", "docx", "image"];

/** Sniffed mime → kind for the binary formats that are not images (CUR-4664). The OOXML and ODF
 *  formats and EPUB are zip containers; RTF has its own `{\rtf` signature. */
const BINARY_MIME_KIND: Record<string, UploadKind> = {
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/rtf": "rtf",
	"application/epub+zip": "epub",
};

/** Zip-container kinds by extension. A sniff that reads only a file's first few KB can see the zip
 *  but not which format it is (an OOXML file whose [Content_Types].xml comes late); the name then
 *  picks between them, and the archive walk still opens every part. */
export const ZIP_KIND_BY_EXTENSION: Record<string, UploadKind> = {
	docx: "docx",
	xlsx: "xlsx",
	pptx: "pptx",
	odt: "odt",
	ods: "ods",
	odp: "odp",
	epub: "epub",
};

/**
 * Photo types the known-abuse scanner (HMA) cannot hash: it answers HTTP 500 to a HEIC, and the
 * server's sharp build has no HEVC decoder to convert one. My files redraws these as JPEG in the
 * browser before upload, and the server refuses one it is still handed as an unsupported type rather
 * than as a scanner outage, which a retry could never clear.
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
 *  about a quarter of a second. */
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
	xlsx: 4_000_000,
	pptx: 4_000_000,
	odt: 4_000_000,
	ods: 4_000_000,
	odp: 4_000_000,
	rtf: 4_000_000,
	epub: 4_000_000,
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
	if (BINARY_MIME_KIND[m]) return BINARY_MIME_KIND[m];
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
