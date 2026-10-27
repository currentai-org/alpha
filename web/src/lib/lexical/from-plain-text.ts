import type { LexicalRoot } from './types';

/**
 * Wrap a plain string as a minimal single-paragraph Lexical root, so callers holding plain text
 * (the markdoc IconGrid/Faqs wrappers, the homepage)
 * to components that now render Payload's richText fields via `LexicalRenderer`. Formatting-free
 * by construction — those callers never had formatting to preserve in the first place.
 */
export function lexicalRootFromPlainText(text: string): LexicalRoot {
	return {
		root: {
			children: text
				? [
						{
							type: 'paragraph',
							version: 1,
							children: [{ type: 'text', version: 1, text, format: 0 }]
						}
					]
				: []
		}
	};
}
