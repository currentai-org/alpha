import { describe, expect, it } from 'vitest';
import {
	compactFinishedLinks,
	compactPastedLinks,
	draftSegments,
	expandLinks,
	LINK_MARK,
	type DraftSegment
} from './composerLinks';

const none = new Set<string>();
const joined = (segments: DraftSegment[]) =>
	segments.map((s) => (s.kind === 'text' ? s.text : s.scheme + s.rest)).join('');
const links = (segments: DraftSegment[]) =>
	segments.flatMap((s) => (s.kind === 'link' ? [s.url] : []));

describe('compactPastedLinks', () => {
	it('drops sentence punctuation after a URL but keeps its path and query', () => {
		const { urls } = compactPastedLinks('see https://www.reuters.com/world/a?b=1, and (https://x.org/y).');
		expect(urls).toEqual(['https://www.reuters.com/world/a?b=1', 'https://x.org/y']);
	});

	it('replaces each linked scheme with one mark, so the icon sits against the address with no gap', () => {
		expect(compactPastedLinks('read https://github.com/a/b and http://x.org.').text).toBe(
			`read ${LINK_MARK}github.com/a/b and ${LINK_MARK}x.org.`
		);
	});

	it('keeps the scheme of a URL with no site icon (IP literals, localhost), which stays plain text', () => {
		expect(compactPastedLinks('http://localhost:5173/chat')).toEqual({
			text: 'http://localhost:5173/chat',
			urls: []
		});
	});
});

describe('compactFinishedLinks', () => {
	it('compacts a typed link once a space follows it, keeping the caret after that space', () => {
		const draft = 'read https://github.com/a/b ';
		const { text, urls, caret } = compactFinishedLinks(draft, draft.length);
		expect(text).toBe(`read ${LINK_MARK}github.com/a/b `);
		expect(urls).toEqual(['https://github.com/a/b']);
		expect(caret).toBe(text.length);
	});

	it('leaves a link still being typed alone, so the address never changes under the caret', () => {
		const draft = 'read https://github.com/a';
		expect(compactFinishedLinks(draft, draft.length)).toEqual({ text: draft, urls: [], caret: draft.length });
	});

	it('keeps the caret on the same character when the link is after it', () => {
		const draft = 'ab https://x.org/y z';
		const { text, caret } = compactFinishedLinks(draft, 2);
		expect(caret).toBe(2);
		expect(text.slice(0, caret)).toBe('ab');
	});

	it('sends a typed link back with the scheme it was typed with', () => {
		const draft = 'see http://x.org/y and https://github.com/a ok';
		const { text, urls } = compactFinishedLinks(draft, draft.length);
		expect(expandLinks(text, new Set(urls))).toBe(draft);
	});
});

describe('links written without a scheme', () => {
	it('finds bare domains and http links as well as https ones, and draws each with its icon', () => {
		const draft = 'compare www.bloomberg.com/markets, github.com/a/b and http://x.org/y today';
		const { text, urls } = compactPastedLinks(draft);
		expect(urls).toEqual(['www.bloomberg.com/markets', 'github.com/a/b', 'http://x.org/y']);
		const segments = draftSegments(text, new Set(urls));
		expect(links(segments)).toEqual(urls);
		expect(segments.flatMap((s) => (s.kind === 'link' ? [s.href] : []))).toEqual([
			'https://www.bloomberg.com/markets',
			'https://github.com/a/b',
			'http://x.org/y'
		]);
	});

	it('sends a bare domain back exactly as written, with no scheme added', () => {
		const draft = 'see github.com/a/b and www.bbc.co.uk.';
		const { text, urls } = compactPastedLinks(draft);
		expect(expandLinks(text, new Set(urls))).toBe(draft);
	});

	it('leaves file names, version numbers and email addresses as text', () => {
		expect(compactPastedLinks('edit readme.md and app.py, v1.2.3, mail me@example.com').urls).toEqual([]);
	});

	it('compacts a typed bare domain once a space follows it, keeping the caret after that space', () => {
		const draft = 'read bloomberg.com ';
		const { text, urls, caret } = compactFinishedLinks(draft, draft.length);
		expect(text).toBe(`read ${LINK_MARK}bloomberg.com `);
		expect(urls).toEqual(['bloomberg.com']);
		expect(caret).toBe(text.length);
		expect(compactFinishedLinks(text, caret).urls).toEqual([]);
	});
});

describe('expandLinks', () => {
	it('sends every pasted link with the scheme it was pasted with, punctuation after it kept', () => {
		const pasted = 'compare https://github.com/a/b, http://x.org/y.';
		const { text, urls } = compactPastedLinks(pasted);
		expect(expandLinks(text, new Set(urls))).toBe(pasted);
	});

	it('reads a mark whose pasted URL is no longer known as https, so no message goes out schemeless', () => {
		expect(expandLinks(`see ${LINK_MARK}example.org/page`, new Set())).toBe('see https://example.org/page');
	});

	it('leaves spacing typed before a word that is not an address as typed', () => {
		const typed = `see https://example.org and${LINK_MARK}spacing`;
		expect(expandLinks(typed, new Set())).toBe(typed);
	});
});

describe('draftSegments', () => {
	it('joins back into exactly the draft, so the drawn layer lines up with the textarea', () => {
		for (const draft of [
			'',
			'plain text\nwith lines\n',
			'Summarize https://www.reuters.com/world/a, then (https://x.org/y). ',
			'https://a.org/x https://a.org/x\n\nhttps://exam',
			'http://127.0.0.1:5199/chat http://localhost:5173 '
		]) {
			expect(joined(draftSegments(draft, none)), draft).toBe(draft);
			expect(joined(draftSegments(draft, new Set(compactPastedLinks(draft).urls))), draft).toBe(draft);
			const pasted = compactPastedLinks(draft);
			expect(joined(draftSegments(pasted.text, new Set(pasted.urls))), draft).toBe(pasted.text);
		}
	});

	it('marks a pasted URL as a link even with nothing typed after it, scheme split off for the icon', () => {
		const url = 'https://www.reuters.com/world/americas/who-is-rodrigo-paz';
		expect(draftSegments(`summarize ${url}`, new Set([url]))).toEqual([
			{ kind: 'text', text: 'summarize ' },
			{
				kind: 'link',
				url,
				href: url,
				scheme: 'https://',
				rest: 'www.reuters.com/world/americas/who-is-rodrigo-paz'
			}
		]);
	});

	it('draws a pasted link from its mark, with the URL it was pasted as', () => {
		const url = 'https://github.com/currentai-org/aipotluck.org/pull/3260';
		const { text, urls } = compactPastedLinks(url);
		const segments = draftSegments(`look ${text}`, new Set(urls));
		expect(joined(segments)).toBe(`look ${text}`);
		expect(segments.at(-1)).toEqual({
			kind: 'link',
			url,
			href: url,
			scheme: LINK_MARK,
			rest: 'github.com/currentai-org/aipotluck.org/pull/3260'
		});
	});

	it('leaves a typed URL as text until whitespace follows it, so a half-written host is never asked for', () => {
		expect(links(draftSegments('read https://exam', none))).toEqual([]);
		expect(links(draftSegments('read https://example.com ', none))).toEqual(['https://example.com']);
	});

	it('keeps sentence punctuation after a link as text', () => {
		const segments = draftSegments('see https://x.org/y. ok', none);
		expect(links(segments)).toEqual(['https://x.org/y']);
		expect(segments.at(-1)).toEqual({ kind: 'text', text: '. ok' });
	});

	it('leaves hosts with no site icon as text: IP literals and localhost', () => {
		expect(links(draftSegments('http://127.0.0.1:5199/chat http://localhost:5173 ', none))).toEqual([]);
	});
});
