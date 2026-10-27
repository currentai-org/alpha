// Clipboard text for a selection inside a rendered answer (CUR-2421).
//
// `textContent` is the wrong source for `text/plain`: it keeps text no reader sees on screen (the
// visually hidden " (unverified link)" label and the "?" marker that marked.ts adds to an unverified
// link), and it joins block elements with nothing between them, so a heading runs into the paragraph
// after it ("Prendre rendez-vousContactez").

// Elements that exist for assistive tech or for the screen only, and should not travel in a copy.
// The unverified-link warning stays visible on screen and announced to screen readers; it just
// doesn't belong in the person's pasted email.
const COPY_NOISE = "[data-exclude-from-copy], .sr-only, [data-uv-mark]";

export function removeCopyNoise(root: ParentNode): void {
	root.querySelectorAll(COPY_NOISE).forEach((el) => el.remove());
}

// Blank line after these, as a paragraph break reads in plain text.
const PARAGRAPH_BLOCKS = new Set([
	"P",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"PRE",
	"BLOCKQUOTE",
	"UL",
	"OL",
	"TABLE",
	"HR",
	"FIGURE",
]);
// Single line break around these.
const LINE_BLOCKS = new Set(["LI", "TR", "DIV", "SECTION", "ARTICLE", "DT", "DD"]);

// Text from inside a <pre> is kept apart so the break before it never trims its indentation.
type Piece = string | { pre: string } | { br: 1 | 2 };

/**
 * Plain text for `root` with line breaks where the rendered blocks break.
 *
 * Whitespace-only text between blocks (marked emits a newline after each block) is dropped, since the
 * block boundaries already supply the break; text inside `<pre>` is kept exactly.
 */
export function plainTextOf(root: Node): string {
	const pieces: Piece[] = [];

	const walk = (node: Node, inPre: boolean) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const value = node.nodeValue ?? "";
			if (!inPre && /^\s*$/.test(value) && value.includes("\n")) return;
			pieces.push(inPre ? { pre: value } : value);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
			return;
		}
		const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : "";
		if (tag === "BR") {
			pieces.push({ br: 1 });
			return;
		}
		const br: 0 | 1 | 2 = PARAGRAPH_BLOCKS.has(tag) ? 2 : LINE_BLOCKS.has(tag) ? 1 : 0;
		if (br) pieces.push({ br });
		if (tag === "TD" || tag === "TH") {
			const prev = (node as Element).previousElementSibling;
			if (prev) pieces.push("\t");
		}
		const childInPre = inPre || tag === "PRE";
		node.childNodes.forEach((child) => walk(child, childInPre));
		if (br) pieces.push({ br });
	};
	walk(root, false);

	// Runs of adjacent breaks collapse to the widest one; a break with no text before or after it
	// disappears.
	let out = "";
	let pending = 0;
	for (const piece of pieces) {
		if (typeof piece !== "string" && "br" in piece) {
			pending = Math.max(pending, piece.br);
			continue;
		}
		const pre = typeof piece !== "string";
		const text = pre ? piece.pre : piece;
		if (text === "") continue;
		if (pending && out) {
			out =
				out.replace(/[ \t]+$/, "") + "\n".repeat(pending) + (pre ? text : text.replace(/^[ \t]+/, ""));
		} else {
			out += text;
		}
		pending = 0;
	}
	return out;
}
