import { describe, expect, it } from 'vitest';
import { lexicalParagraphTexts, lexicalToPlainText } from './to-plain-text';
import type { LexicalRoot } from './types';

const doc = (...paragraphs: string[]): LexicalRoot => ({
	root: {
		children: paragraphs.map((text) => ({
			type: 'paragraph',
			version: 1,
			children: [{ type: 'text', version: 1, text, format: 0 }]
		}))
	}
});

describe('lexicalToPlainText', () => {
	it('returns the empty string for null content, so callers can treat "no text" as falsy', () => {
		expect(lexicalToPlainText(null)).toBe('');
		expect(lexicalToPlainText(undefined)).toBe('');
	});

	it('separates block-level nodes with a space rather than running them together', () => {
		expect(lexicalToPlainText(doc('Hello', 'World'))).toBe('Hello World');
	});

	it('collapses runs of whitespace and trims, so the result is safe for a meta tag', () => {
		expect(lexicalToPlainText(doc('  Hello \n\n  there  '))).toBe('Hello there');
	});

	it('descends into nested inline nodes instead of reading only top-level text', () => {
		const nested: LexicalRoot = {
			root: {
				children: [
					{
						type: 'paragraph',
						version: 1,
						children: [
							{ type: 'text', version: 1, text: 'plain ', format: 0 },
							{
								type: 'link',
								version: 1,
								children: [{ type: 'text', version: 1, text: 'linked', format: 0 }]
							}
						]
					}
				]
			}
		};
		expect(lexicalToPlainText(nested)).toBe('plain linked');
	});
});

describe('lexicalParagraphTexts', () => {
	const text = (t: string, format = 0) => ({ type: 'text', version: 1, text: t, format });
	const paragraph = (...children: Record<string, unknown>[]) => ({
		type: 'paragraph',
		version: 1,
		children
	});

	it('returns no paragraphs for null content', () => {
		expect(lexicalParagraphTexts(null, 3)).toEqual([]);
	});

	it('returns only the first `limit` paragraphs, one string each', () => {
		expect(lexicalParagraphTexts(doc('One', 'Two', 'Three'), 2)).toEqual(['One', 'Two']);
	});

	it('skips headings and empty spacer paragraphs instead of counting them against the limit', () => {
		const content = {
			root: {
				children: [
					{ type: 'heading', tag: 'h2', version: 1, children: [text('Manifesto')] },
					paragraph(),
					paragraph(text('  ')),
					paragraph(text('First')),
					paragraph(text('Second'))
				]
			}
		};
		expect(lexicalParagraphTexts(content, 2)).toEqual(['First', 'Second']);
	});

	it('joins inline nodes flush, so a link or bold run keeps its punctuation attached', () => {
		const content = {
			root: {
				children: [
					paragraph(
						text('Read '),
						{ type: 'link', version: 1, children: [text('this')] },
						text('bold', 1),
						text(', now.')
					)
				]
			}
		};
		expect(lexicalParagraphTexts(content, 1)).toEqual(['Read thisbold, now.']);
	});

	it('keeps a soft line break as a newline rather than flattening it into a space', () => {
		const content = {
			root: {
				children: [
					paragraph(text('A trap. '), { type: 'linebreak', version: 1 }, text(' By race logic'))
				]
			}
		};
		expect(lexicalParagraphTexts(content, 1)).toEqual(['A trap.\nBy race logic']);
	});
});
