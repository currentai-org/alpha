// HTML → text extraction for the admin ingest-from-url path (Phase 3), and the fallback behind
// readableExtract.ts. Pure + leaf so it's unit-testable in the hermetic gate. htmlparser2 does the
// parsing and entity decoding (CUR-4068); this walks the tree, drops script/style/noise blocks,
// ends each block element with a newline so adjacent blocks don't merge into one word, and collapses
// whitespace. The extracted text is REVIEWED by an admin before it's saved (and the grounding layer
// fences all retrieved text as untrusted).

import { parseDocument, DomUtils, ElementType } from "htmlparser2";

// domhandler is htmlparser2's own dependency, so its node type is read off parseDocument.
type ChildNode = ReturnType<typeof parseDocument>["children"][number];

// Blocks whose textual content is noise: code, styling and the document head.
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "head"]);
const BLOCK = new Set([
	"p",
	"div",
	"li",
	"ul",
	"ol",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"tr",
	"table",
	"section",
	"article",
	"header",
	"footer",
	"blockquote",
	"pre",
	"figcaption",
]);

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function walk(nodes: ChildNode[], out: string[]): void {
	for (const node of nodes) {
		if (node.type === ElementType.Text) {
			out.push(node.data);
		} else if (node.type === ElementType.Tag) {
			if (SKIP.has(node.name)) continue;
			if (node.name === "br") {
				out.push("\n");
				continue;
			}
			walk(node.children, out);
			if (BLOCK.has(node.name)) out.push("\n");
			else out.push(" ");
		}
		// Comments, CDATA and directives carry no visible text in an HTML page.
	}
}

/** Extract a best-effort `{ title, text }` from an HTML string. Both default to "" when absent. */
export function extractTextFromHtml(html: string): { title: string; text: string } {
	const doc = parseDocument(html ?? "");
	const titleEl = DomUtils.findOne((el) => el.name === "title", doc.children);
	const title = titleEl ? collapse(DomUtils.textContent(titleEl)) : "";

	const out: string[] = [];
	walk(doc.children, out);
	const text = out
		.join("")
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ") // collapse spaces/tabs but keep newlines
		.replace(/ *\n */g, "\n") // trim around newlines
		.replace(/\n{3,}/g, "\n\n") // cap blank runs
		.trim();

	return { title, text };
}
