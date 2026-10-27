import { describe, expect, it } from 'vitest';
import { resolveMetaDescription, truncateOnWordBoundary, webPageJsonLd } from './site';
import type { LexicalRoot } from '$lib/lexical/types';

const body = (text: string): LexicalRoot => ({
	root: {
		children: [
			{
				type: 'paragraph',
				version: 1,
				children: [{ type: 'text', version: 1, text, format: 0 }]
			}
		]
	}
});

const LONG = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(
	5
);

describe('resolveMetaDescription', () => {
	it('returns an authored description VERBATIM even past 150 chars (too long beats mangled)', () => {
		const authored = LONG.trim();
		expect(authored.length).toBeGreaterThan(150);
		expect(resolveMetaDescription({ meta: { description: authored }, content: body('body') })).toBe(
			authored
		);
	});

	it('falls back to the body text when no description is authored', () => {
		expect(resolveMetaDescription({ meta: null, content: body('Body copy here') })).toBe(
			'Body copy here'
		);
	});

	it('truncates the FALLBACK to 150 chars, so a long article body cannot become the meta tag', () => {
		const result = resolveMetaDescription({ meta: null, content: body(LONG) });
		expect(result!.length).toBeLessThanOrEqual(151); // 150 + the appended ellipsis
		expect(result!.endsWith('…')).toBe(true);
	});

	it('treats an empty-string description as absent rather than emitting an empty meta tag', () => {
		expect(resolveMetaDescription({ meta: { description: '' }, content: body('Body copy') })).toBe(
			'Body copy'
		);
	});

	it('returns undefined when there is neither a description nor body text, so Seo omits the tags', () => {
		expect(resolveMetaDescription({ meta: null, content: null })).toBeUndefined();
	});
});

describe('webPageJsonLd', () => {
	it('uses the same fallback as the meta tags, so JSON-LD is not left description-less', () => {
		const jsonLd = webPageJsonLd(
			{ title: 'T', meta: null, content: body('Body copy here') },
			'/x'
		) as { description?: string };
		expect(jsonLd.description).toBe('Body copy here');
	});
});

describe('truncateOnWordBoundary', () => {
	it('breaks on a whole word, never mid-word', () => {
		expect(truncateOnWordBoundary('alpha beta gamma delta', 14)).toBe('alpha beta…');
	});

	it('OVERSHOOTS to the next boundary rather than splitting a token that straddles the limit', () => {
		// No space falls inside the first 20 chars, so cutting at the limit would sever the URL.
		// Slightly over-length beats mangled — the same trade as an over-length authored description.
		const text = 'https://example.com/a/very/long/path and more text';
		expect(truncateOnWordBoundary(text, 20)).toBe('https://example.com/a/very/long/path…');
	});

	it('hard-cuts only as a last resort, when the text has no whitespace at all', () => {
		expect(truncateOnWordBoundary('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`);
	});
});

describe('resolveMetaDescription — excerpt chain (Updates)', () => {
	it('prefers an authored SEO description over the excerpt', () => {
		expect(
			resolveMetaDescription({
				meta: { description: 'Authored' },
				excerpt: 'Excerpt',
				content: body('Body')
			})
		).toBe('Authored');
	});

	it('falls back to the excerpt before the body, and leaves it VERBATIM (it is authored too)', () => {
		expect(resolveMetaDescription({ meta: null, excerpt: 'Excerpt', content: body('Body') })).toBe(
			'Excerpt'
		);
	});

	it('falls through to the body when the excerpt is empty', () => {
		expect(resolveMetaDescription({ meta: null, excerpt: '', content: body('Body') })).toBe('Body');
	});
});
