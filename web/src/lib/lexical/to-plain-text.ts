import type { LexicalNode } from './types';

/**
 * Flatten a Lexical document to a single line of plain text — the `web/` counterpart of
 * Payload's `convertLexicalToPlaintext` (payload/src/fields/lexicalPlainText.ts), which
 * can't be imported here: its package carries peer deps on `payload`/React (see
 * `types.ts` for the same reasoning behind the hand-written node types).
 *
 * Block-level nodes are joined with a space so adjacent paragraphs don't run together,
 * and whitespace is collapsed, making the result safe to drop straight into a `<meta>`
 * `content` attribute.
 *
 * Takes the loose shape `lexicalRootSchema` actually validates (`root.children: unknown[]`)
 * for the same reason `LexicalRenderer` does — so callers can pass a `PageDoc`'s `content`
 * straight through without a cast at every call site.
 */
export function lexicalToPlainText(
	content: { root?: { children?: unknown[] } } | null | undefined
): string {
	if (!content) return '';
	return collect((content.root?.children ?? []) as LexicalNode[])
		.replace(/\s+/g, ' ')
		.trim();
}

function collect(nodes: LexicalNode[]): string {
	return nodes
		.map((node) => (node.children ? collect(node.children) : (node.text ?? '')))
		.join(' ');
}

/**
 * The plain text of a Lexical document's first `limit` top-level paragraphs, one string each, for
 * an excerpt that renders inside a link (the Promo Banner's manifesto card), where the document's
 * own inline links would nest one anchor inside another. Headings, lists and blocks are skipped,
 * and so are paragraphs with no text, which editors use as spacers. A soft line break stays a
 * `\n`, for the caller to render with `whitespace-pre-line`.
 */
export function lexicalParagraphTexts(
	content: { root?: { children?: unknown[] } } | null | undefined,
	limit: number
): string[] {
	const paragraphs: string[] = [];
	for (const node of (content?.root?.children ?? []) as LexicalNode[]) {
		if (paragraphs.length >= limit) break;
		if (node.type !== 'paragraph') continue;
		const text = inlineText(node.children ?? [])
			.replace(/[^\S\n]+/g, ' ')
			.replace(/ ?\n ?/g, '\n')
			.trim();
		if (text) paragraphs.push(text);
	}
	return paragraphs;
}

// Inline nodes sit flush against each other ("**bold**," is one word and a comma), unlike the
// block-level nodes `collect` joins with a space.
function inlineText(nodes: LexicalNode[]): string {
	return nodes
		.map((node) =>
			node.type === 'linebreak'
				? '\n'
				: node.children
					? inlineText(node.children)
					: (node.text ?? '')
		)
		.join('');
}
