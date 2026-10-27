import { DOCX_MIME } from "$lib/chat/constants/mime";

// An attachment's chip and the drop refusal show a readable label, not the raw MIME type
// ("application/pdf", or the full openxml string for a Word file).
const LABELS: Record<string, string> = {
	"application/pdf": "PDF document",
	[DOCX_MIME]: "Word document",
	"image/jpeg": "JPEG image",
	"image/png": "PNG image",
	"text/plain": "Text file",
	"text/markdown": "Markdown file",
	"text/csv": "CSV file",
	"application/json": "JSON file",
};

/** What a file is, in words a visitor reads: a known type by name, otherwise its extension. */
export function fileTypeLabel(mime: string, name = ""): string {
	const known = LABELS[mime.split(";")[0]];
	if (known) return known;
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) return `${name.slice(dot + 1).toUpperCase()} file`;
	if (mime.startsWith("image/")) return "Image";
	if (mime.startsWith("text/")) return "Text file";
	return "File";
}
