// A PDF or DOCX reduced to its text before anything is stored (CUR-987, `document-text-only`).
//
// The workaround for accounts `document-attachments` does not select: their pictures cannot be
// hash-scanned yet, so none are kept. The server reads the document's text layer, and the turn
// stores a `.txt` holding only that text in place of the document. The original bytes and every
// picture in them are dropped here, in memory, and never reach uploadFile or the bucket.
//
// Reading the text layer is still in-process parsing (unpdf's text content, mammoth's raw text),
// with no image ever decoded. The sandboxed parser (CUR-2780) remains what gates guests.

import { logger as defaultLogger } from "$lib/chat/server/logger";
import { extractTextFromUpload, RagExtractError } from "$lib/chat/server/rag/extractFile";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Declared uncompressed size a DOCX may have, read from its directory before mammoth inflates it. */
const MAX_DOCX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export const DOCUMENT_TEXT_UNREADABLE_MESSAGE = "We couldn't read any text in this file, so it wasn't added.";

export type DocumentAsText =
	| { status: "text"; file: File }
	/** A document kind text-only mode does not read (a spreadsheet, a slide deck, an ODF file). */
	| { status: "unsupported" }
	/** A PDF or DOCX with no text to keep: scanned, encrypted, corrupt, or too large to read. */
	| { status: "unreadable" };

function kindFor(mime: string, name: string): "pdf" | "docx" | null {
	if (mime === "application/pdf") return "pdf";
	if (mime === DOCX_MIME) return "docx";
	// Some DOCX files sniff as a bare zip; the name is trusted only to pick between zip readers.
	if (mime === "application/zip" && /\.docx$/i.test(name)) return "docx";
	return null;
}

async function docxExpandsTooFar(bytes: Uint8Array): Promise<boolean> {
	const { unzipSync } = await import("fflate");
	let total = 0;
	try {
		// The filter sees each entry's declared size and inflates nothing.
		unzipSync(bytes, {
			filter: (f) => {
				total += f.originalSize;
				return false;
			},
		});
	} catch {
		return true;
	}
	return total > MAX_DOCX_UNZIPPED_BYTES;
}

/**
 * Read `file` (sniffed as `mime`) to a text file named `<name>.txt`. Never throws for a bad
 * document: an unreadable one comes back as a status the caller turns into a refusal line.
 */
export async function documentAsText(
	file: File,
	mime: string,
	deps: { extract?: typeof extractTextFromUpload; logger?: Pick<typeof defaultLogger, "info"> } = {}
): Promise<DocumentAsText> {
	const extract = deps.extract ?? extractTextFromUpload;
	const log = deps.logger ?? defaultLogger;
	const kind = kindFor(mime, file.name);
	if (!kind) return { status: "unsupported" };
	const started = Date.now();
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (kind === "docx" && (await docxExpandsTooFar(bytes))) {
		log.info({ kind, ms: Date.now() - started }, "[documents] text-only refused, archive expands too far");
		return { status: "unreadable" };
	}
	try {
		const { text } = await extract({ bytes, name: file.name, kind });
		if (!text.trim()) return { status: "unreadable" };
		log.info({ kind, chars: text.length, ms: Date.now() - started }, "[documents] read to text only");
		return { status: "text", file: new File([text], `${file.name}.txt`, { type: "text/plain" }) };
	} catch (e) {
		if (!(e instanceof RagExtractError)) throw e;
		log.info({ kind, ms: Date.now() - started }, "[documents] text-only refused, no readable text");
		return { status: "unreadable" };
	}
}
