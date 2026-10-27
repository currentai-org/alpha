// Server-side text extraction for the RAG admin upload feature. Given an uploaded file's bytes, it
// derives a clean title + plain text (and the sourceType) to feed the EXISTING create→chunk→embed
// pipeline (createRagDocument). One module, one job: parse-to-text. Images are NOT handled here —
// they go through captionImage.ts (VLM caption + OCR).
//
// Library choices (all serverless-safe on Vercel nodejs22, lazily imported so a CSV/text upload
// never loads the PDF machinery and the hermetic unit tests stay light):
//   • PDF  → unpdf (pure-JS pdf.js build; pdf-parse does not run reliably on Vercel serverless). Scanned/no-text-layer PDFs
//            yield empty text and are rejected with a clear message (upload them as images instead).
//   • DOCX → mammoth (extractRawText). .docx only, not legacy .doc.
//   • CSV/TSV → papaparse (header rows → "col: value; …" lines, one row per chunk-unit, no overlap).
//   • JSON/JSONL → JSON.parse / line-parse → labeled "key: value" blocks.
//   • HTML → extractReadableHtml: Readability with `readable-extract` on, the regex extractor otherwise (CUR-2152).
//   • TXT/Markdown → UTF-8 decode (Markdown kept raw — headings/lists carry retrieval signal).
//
// The byte/text caps and the file-type sniff keep a hostile upload from blowing the function budget.

import { extractReadableHtml } from "./readableExtract";
import {
	classifyByMime,
	classifyUpload,
	extensionOf,
	MAX_PDF_PAGES,
	titleFromFilename,
	UPLOAD_MAX_BYTES,
	UPLOAD_MAX_BYTES_ANY,
	type UploadKind,
} from "$lib/chat/constants/ragUpload";

/** A parse/validation problem the route maps to a 4xx (unsupported, too big, empty, no text). */
export class RagExtractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RagExtractError";
	}
}

/** Bound the extracted text fed to the chunker/embed loop (the chunker also caps at 50 chunks). */
const MAX_TEXT_CHARS = 200_000;

export type ExtractedFile = { title: string; text: string; sourceType: UploadKind };

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Resolve the upload kind from a magic-byte sniff (file-type) first, then filename/declared mime.
 * file-type only detects BINARY formats, so when it fires we trust the bytes ALONE (by mime, ignoring
 * the spoofable extension): a sniffed-but-unsupported binary is rejected rather than reinterpreted as
 * text/image via its name. Only text-like inputs (no magic bytes) fall back to the extension. Returns
 * null for unsupported types.
 */
export async function resolveUploadKind(input: {
	bytes: Uint8Array;
	name: string;
	declaredMime?: string;
}): Promise<UploadKind | null> {
	let sniffedMime: string | undefined;
	try {
		const { fileTypeFromBuffer } = await import("file-type");
		const ft = await fileTypeFromBuffer(input.bytes);
		sniffedMime = ft?.mime;
	} catch {
		/* sniff is best-effort; fall back to declared mime + extension below */
	}
	if (sniffedMime) {
		const byMime = classifyByMime(sniffedMime);
		if (byMime) return byMime;
		// A .docx is a zip container some detectors report generically as application/zip.
		if (sniffedMime === "application/zip" && extensionOf(input.name) === "docx") return "docx";
		// A definitively-sniffed binary we don't support — do NOT trust the extension. Reject.
		return null;
	}
	// No magic bytes ⇒ a text-like format; classify by extension / declared mime.
	return classifyUpload(input.name, input.declaredMime);
}

/** Serialize CSV/TSV: each row → one "col: value; col: value" unit, blank-line separated (so the
 *  chunker treats rows as atomic units with NO overlap). Header row drives the labels. */
export async function csvToText(raw: string, tsv = false): Promise<string> {
	const Papa = (await import("papaparse")).default;
	const parsed = Papa.parse<Record<string, unknown>>(raw, {
		header: true,
		skipEmptyLines: "greedy",
		delimiter: tsv ? "\t" : undefined,
	});
	const rows = Array.isArray(parsed.data) ? parsed.data : [];
	const lines = rows
		.map((row) =>
			Object.entries(row)
				.filter(([, v]) => v != null && String(v).trim() !== "")
				.map(([k, v]) => `${k.trim()}: ${String(v).trim()}`)
				.join("; ")
		)
		.filter((l) => l.length > 0);
	return lines.join("\n\n");
}

/** Render one parsed record as labeled "key: value" lines (values stringified; nested → JSON). */
function recordToText(rec: unknown): string {
	if (rec == null) return "";
	if (typeof rec !== "object") return String(rec).trim();
	return Object.entries(rec as Record<string, unknown>)
		.map(([k, v]) => {
			const val = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).trim();
			return val ? `${k}: ${val}` : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** JSON (array or object) or JSONL/NDJSON (one record per line) → blank-line-separated text blocks. */
export function jsonToText(raw: string, jsonl: boolean): string {
	const blocks: string[] = [];
	if (jsonl) {
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			try {
				blocks.push(recordToText(JSON.parse(t)));
			} catch {
				blocks.push(t); // keep the raw line rather than dropping content
			}
		}
	} else {
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new RagExtractError("That JSON file could not be parsed.");
		}
		const records = Array.isArray(data) ? data : [data];
		for (const r of records) blocks.push(recordToText(r));
	}
	return blocks.filter((b) => b.trim()).join("\n\n");
}

/** Hard wall-clock bound on a single parse, so a pathological binary can't pin the serverless
 *  function. The byte cap already bounds input size; this bounds CPU/time on top of it. */
const PARSE_TIMEOUT_MS = 20_000;

function withParseTimeout<T>(p: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(
			() => reject(new RagExtractError(`Reading this ${label} took too long; try a smaller file.`)),
			PARSE_TIMEOUT_MS
		);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
	try {
		return await withParseTimeout(
			(async () => {
				const { extractText, getDocumentProxy } = await import("unpdf");
				// unpdf refuses a Node Buffer ("provide binary data as `Uint8Array`"), and a chat
				// attachment decoded from base64 is one, often a view into Node's shared pool. A plain
				// copy is the only shape it accepts from every caller (CUR-987).
				const pdf = await getDocumentProxy(new Uint8Array(bytes));
				// Refused before any page is read; the timeout above stops waiting but not the parse (CUR-3837).
				const pages = pdf.numPages;
				if (pages > MAX_PDF_PAGES) {
					await pdf.loadingTask.destroy();
					throw new RagExtractError(
						`This PDF has ${pages.toLocaleString("en")} pages; the limit is ${MAX_PDF_PAGES.toLocaleString("en")}.`
					);
				}
				// mergePages:true returns a single concatenated string for the whole document.
				const { text } = await extractText(pdf, { mergePages: true });
				return text.trim();
			})(),
			"PDF"
		);
	} catch (e) {
		if (e instanceof RagExtractError) throw e;
		// A renamed/corrupt/encrypted file reaches the parser despite the sniff — surface a clean 4xx
		// rather than letting the library's internal error escape as a 500 with its message.
		throw new RagExtractError(
			"Could not read this PDF (it may be corrupt, encrypted, or not a PDF)."
		);
	}
}

async function docxToText(bytes: Uint8Array): Promise<string> {
	try {
		return await withParseTimeout(
			(async () => {
				const mammoth = (await import("mammoth")).default;
				const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
				return (value || "").trim();
			})(),
			"DOCX"
		);
	} catch (e) {
		if (e instanceof RagExtractError) throw e;
		throw new RagExtractError("Could not read this DOCX (it may be corrupt or not a .docx file).");
	}
}

/**
 * Extract title + text from a NON-image upload of the given (already-resolved) kind. Enforces the
 * per-kind byte cap and throws RagExtractError on anything unreadable. Image kinds are rejected here
 * — the route sends them to captionImage instead.
 */
export async function extractTextFromUpload(input: {
	bytes: Uint8Array;
	name: string;
	kind: UploadKind;
}): Promise<ExtractedFile> {
	const { bytes, name, kind } = input;
	if (bytes.byteLength === 0) throw new RagExtractError("File is empty.");
	if (bytes.byteLength > UPLOAD_MAX_BYTES_ANY) throw new RagExtractError("File is too large.");
	if (bytes.byteLength > UPLOAD_MAX_BYTES[kind]) {
		throw new RagExtractError(`This ${kind} file exceeds its size limit.`);
	}
	if (kind === "image") {
		throw new RagExtractError("Images are captioned, not text-extracted.");
	}

	let title = titleFromFilename(name);
	let text = "";
	switch (kind) {
		case "pdf":
			text = await pdfToText(bytes);
			if (!text) {
				throw new RagExtractError(
					"No text layer found (scanned PDF?). Upload a text-based PDF, or upload the page as an image."
				);
			}
			break;
		case "docx":
			text = await docxToText(bytes);
			break;
		case "csv":
			text = await csvToText(decodeUtf8(bytes), /\.tsv$/i.test(name));
			break;
		case "json":
			text = jsonToText(decodeUtf8(bytes), /\.(jsonl|ndjson)$/i.test(name));
			break;
		case "html": {
			const r = await extractReadableHtml(decodeUtf8(bytes), "upload");
			text = r.text;
			if (r.title.trim()) title = r.title.trim();
			break;
		}
		case "markdown":
		case "text":
			text = decodeUtf8(bytes);
			break;
	}

	text = text.trim();
	if (!text) throw new RagExtractError("No readable text could be extracted from this file.");
	if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
	return { title, text, sourceType: kind };
}
