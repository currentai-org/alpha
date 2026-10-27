import { faviconHost } from '$lib/favicon';

/** A run of the composer draft: plain text, or a link drawn with its site's icon. */
export type DraftSegment =
	| { kind: 'text'; text: string }
	| {
			kind: 'link';
			/** The link as written (with or without a scheme), trailing punctuation removed. */
			url: string;
			/** The link with a scheme, for asking for its icon. */
			href: string;
			/** `https://` or `http://` as typed, or LINK_MARK; the icon is drawn in its place. */
			scheme: string;
			/** Everything after the scheme. */
			rest: string;
	  };

/**
 * A link's scheme is stored in the draft as seven no-break spaces, about 19px at the composer's 16px:
 * the icon (16px) drawn over them, then a small gap before the address, instead of the blank width
 * of `https://`. A bare domain gets the same mark in front of it. The textarea and the layer drawn
 * behind it have to match character for character, so this is the only way to make room for the icon
 * without the scheme's width. No-break spaces because Plus Jakarta Sans has them: WebKit draws an em
 * or thin space the font lacks as a plain space, which left the icon over the address. `expandLinks`
 * writes each link back as it was before the message is sent.
 */
export const LINK_MARK = '\u00a0'.repeat(7);

// Endings a bare domain is read as a link with. Common file extensions that are also country codes
// (md, py, sh, rs, so) are left out, so `readme.md` or `app.py` in a message stays text.
const TLDS = [
	'com', 'org', 'net', 'edu', 'gov', 'int', 'io', 'ai', 'dev', 'app', 'co', 'info', 'me', 'tv',
	'xyz', 'tech', 'news', 'blog', 'site', 'online', 'store', 'cloud', 'page', 'link', 'wiki',
	'ch', 'de', 'fr', 'uk', 'es', 'it', 'nl', 'eu', 'ca', 'au', 'in', 'jp', 'cn', 'br', 'ru', 'se',
	'no', 'fi', 'dk', 'pl', 'pt', 'be', 'at', 'ie', 'nz', 'za', 'mx', 'kr', 'sg', 'hk', 'tw', 'us',
	'ar', 'cl', 'gr', 'cz', 'hu', 'ro', 'tr', 'il', 'ae', 'ua', 'is', 'ng', 'ke', 'ph', 'vn', 'th'
].join('|');
const END = String.raw`[^\s<>"'\`]`;
// An http(s) URL up to the next whitespace, quote or angle bracket.
const SCHEMED = String.raw`https?:\/\/${END}+`;
// A bare domain, with an optional port and path: `github.com/a`, `www.bbc.co.uk`. Not the part of an
// email address or a path after `@`, `.` or `/`, and not an address already carrying LINK_MARK.
const BARE = String.raw`(?<![\w@./\u00a0-])(?:www\.(?:[a-z0-9-]+\.)*[a-z]{2,}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS}))(?![\w-])(?::\d{2,5})?(?:[/?#]${END}*)?`;
const LINK = new RegExp(`${SCHEMED}|${BARE}`, 'gi');
const LINK_IN_DRAFT = new RegExp(`${LINK_MARK}${END}+|${SCHEMED}|${BARE}`, 'gi');
// Sentence punctuation that ends a URL in prose rather than belonging to it.
const TRAILING = /[.,;:!?)\]}]+$/;

const schemeOf = (link: string) => /^https?:\/\//i.exec(link)?.[0] ?? '';
const withScheme = (link: string) => (schemeOf(link) ? link : `https://${link}`);
/** Whether a link has a site icon to ask for: not an IP literal or localhost. */
const linkable = (link: string) => faviconHost(withScheme(link)) !== null;
const finishedAt = (draft: string, end: number) => end < draft.length && /\s/.test(draft[end]);

/**
 * The draft split into text and links; joined back together the segments are exactly `draft`, so
 * a layer drawing them lines up character for character with the textarea.
 *
 * A link compacted to LINK_MARK is drawn with its icon in the mark. A typed `https://` URL counts as
 * a link once it was pasted or has whitespace after it (until the composer compacts it), so a
 * half-written host never gets an icon request per keystroke. A bare domain not yet compacted has no
 * room for an icon and stays text. Hosts with no site icon (IP literals, localhost) stay text.
 */
export function draftSegments(draft: string, known: ReadonlySet<string>): DraftSegment[] {
	const segments: DraftSegment[] = [];
	let cursor = 0;
	const text = (to: number) => {
		if (to > cursor) segments.push({ kind: 'text', text: draft.slice(cursor, to) });
		cursor = to;
	};
	const compact = compactForms(known);
	for (const m of draft.matchAll(LINK_IN_DRAFT)) {
		const start = m.index ?? 0;
		const written = m[0].replace(TRAILING, '');
		if (written.startsWith(LINK_MARK)) {
			const rest = written.slice(LINK_MARK.length);
			const url = compact.get(written) ?? rest;
			if (!LOOKS_LIKE_HOST.test(rest) || !linkable(url)) continue;
			text(start);
			segments.push({ kind: 'link', url, href: withScheme(url), scheme: LINK_MARK, rest });
			cursor = start + written.length;
			continue;
		}
		const scheme = schemeOf(written);
		if (!scheme) continue;
		if (!(known.has(written) || finishedAt(draft, start + m[0].length)) || !linkable(written)) continue;
		text(start);
		segments.push({ kind: 'link', url: written, href: written, scheme, rest: written.slice(scheme.length) });
		cursor = start + written.length;
	}
	text(draft.length);
	return segments;
}

/** Each known link keyed by how it sits in the draft: LINK_MARK and the address after its scheme. */
function compactForms(known: ReadonlySet<string>): Map<string, string> {
	return new Map([...known].map((link) => [LINK_MARK + link.slice(schemeOf(link).length), link]));
}

/** `text` with each link that gets a site icon compacted, and the links as written. */
function compact(
	text: string,
	caret: number,
	only: (offset: number, length: number) => boolean
): { text: string; urls: string[]; caret: number } {
	const urls: string[] = [];
	let shift = 0;
	const compacted = text.replace(LINK, (match: string, offset: number) => {
		const link = match.replace(TRAILING, '');
		if (!only(offset, match.length) || !linkable(link)) return match;
		urls.push(link);
		const scheme = schemeOf(link);
		// Characters removed (scheme) minus added (mark) before the caret, so it stays on its character.
		if (offset < caret) shift += Math.min(scheme.length, caret - offset) - Math.min(LINK_MARK.length, caret - offset);
		return LINK_MARK + match.slice(scheme.length);
	});
	return { text: compacted, urls, caret: caret - shift };
}

/**
 * Pasted text as it goes into the draft: each link that gets a site icon, with a scheme or without,
 * is written as LINK_MARK and its address. Returns the text and the links as pasted, which the
 * composer keeps to draw and restore them.
 */
export function compactPastedLinks(text: string): { text: string; urls: string[] } {
	const { text: compacted, urls } = compact(text, 0, () => true);
	return { text: compacted, urls };
}

/**
 * A typed draft with each finished link (whitespace typed after it) compacted like a pasted one, and
 * where the caret lands. A link still being typed is left alone, so an address never changes under
 * the caret.
 */
export function compactFinishedLinks(
	draft: string,
	caret: number
): { text: string; urls: string[]; caret: number } {
	return compact(draft, caret, (offset, length) => finishedAt(draft, offset + length));
}

// A domain name and whatever path follows it: `example.org`, `www.x.co.uk/a?b`.
const LOOKS_LIKE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(?:[/?#:]|$)/i;

/**
 * The draft as it is sent: every compacted link is written back as it was, scheme included or not.
 * A mark whose link is no longer known (the draft outlived the paste) is read as `https://` when a
 * domain follows it; spacing someone typed before an ordinary word is left alone.
 */
export function expandLinks(draft: string, known: ReadonlySet<string>): string {
	if (!draft.includes(LINK_MARK)) return draft;
	const forms = compactForms(known);
	return draft.replace(new RegExp(`${LINK_MARK}${END}+`, 'g'), (match) => {
		const written = match.replace(TRAILING, '');
		const rest = written.slice(LINK_MARK.length);
		const link = forms.get(written) ?? (LOOKS_LIKE_HOST.test(rest) ? `https://${rest}` : undefined);
		return link ? link + match.slice(written.length) : match;
	});
}
