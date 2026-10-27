import { Marked } from 'marked';
import { unwrapMarkdownFences } from './unwrapMarkdownFences';
import { base } from '$lib/chat/paths';
import type { Tokens, TokenizerExtension, RendererExtension } from 'marked';
import { parseDocument } from 'htmlparser2';
// Simple type to replace removed WebSearchSource
type SimpleSource = {
	title?: string;
	link: string;
	/** Where the answer first cites this source, 0 for its first citation; unset when uncited. */
	citedRank?: number;
};
import { parseIncompleteMarkdown } from './parseIncompleteMarkdown';
import { finalizeMarkdown } from './finalizeMarkdown';
import { parseMarkdownIntoBlocks } from './parseBlocks';
import { htmlTextDirection } from './textDirection';
import { collapseMarkerRun, collapseSources } from './collapseSources';
import { bracketCitations } from './trace/citedIndices';
import { UNVERIFIED_HREF, UNVERIFIED_TITLE } from '$lib/chat/constants/unverifiedHref';

// ── Lazy heavy renderers ──────────────────────────────────────────────────────────────────────
// KaTeX (~80KB gz) and highlight.js (+languages) are the bulk of the markdown bundle, but the
// landing renders no math/code — so they are DYNAMICALLY imported, never static. That keeps them
// out of the eager client chunk (much faster first hydration, esp. on mobile). They load on first
// actual need (a math token / a code block) or via prefetchMarkdownAssets() during idle. Until a
// lib is present the sync path renders a READABLE fallback (plain code / raw math) and the async
// worker render upgrades it once loaded — content is NEVER blocked on the download.

type KatexRender = (tex: string, opts: { throwOnError: boolean; displayMode: boolean }) => string;
let katexRender: KatexRender | null = null;
let katexPromise: Promise<void> | null = null;
/** Load KaTeX (idempotent). Triggered only when a math token is actually present. */
export function ensureKatex(): Promise<void> {
	if (katexRender) return Promise.resolve();
	if (!katexPromise) {
		katexPromise = import('katex')
			.then(async (m) => {
				// mhchem is a side-effect-only extension (chemistry macros) with no type declaration.
				// @ts-expect-error - no types; imported for its side effect on the katex singleton
				await import('katex/dist/contrib/mhchem.mjs');
				katexRender = (tex, opts) => m.default.renderToString(tex, opts);
			})
			.catch(() => {
				katexPromise = null; // transient failure — allow a later retry
			});
	}
	return katexPromise;
}

type HljsLike = {
	getLanguage: (n: string) => unknown;
	highlight: (
		code: string,
		opts: { language: string; ignoreIllegals: boolean }
	) => { value: string };
	highlightAuto: (code: string) => { value: string };
};
let hljs: HljsLike | null = null;
let hljsPromise: Promise<void> | null = null;
/** Load highlight.js core + a trimmed common-language set (idempotent). The long tail
 *  (java/c#/c/c++/scss/…) falls back to highlightAuto, which still works — just smaller. */
export function ensureHljs(): Promise<void> {
	if (hljs) return Promise.resolve();
	if (!hljsPromise) {
		hljsPromise = (async () => {
			const [core, ...langs] = await Promise.all([
				import('highlight.js/lib/core'),
				import('highlight.js/lib/languages/javascript'),
				import('highlight.js/lib/languages/typescript'),
				import('highlight.js/lib/languages/python'),
				import('highlight.js/lib/languages/json'),
				import('highlight.js/lib/languages/bash'),
				import('highlight.js/lib/languages/shell'),
				import('highlight.js/lib/languages/go'),
				import('highlight.js/lib/languages/rust'),
				import('highlight.js/lib/languages/sql'),
				import('highlight.js/lib/languages/yaml'),
				import('highlight.js/lib/languages/xml'),
				import('highlight.js/lib/languages/css'),
				import('highlight.js/lib/languages/markdown'),
				import('highlight.js/lib/languages/plaintext')
			]);
			const names = [
				'javascript',
				'typescript',
				'python',
				'json',
				'bash',
				'shell',
				'go',
				'rust',
				'sql',
				'yaml',
				'xml',
				'css',
				'markdown',
				'plaintext'
			];
			const h = core.default;
			names.forEach((n, i) => h.registerLanguage(n, langs[i].default));
			h.registerLanguage('html', langs[names.indexOf('xml')].default); // html ↦ xml grammar
			hljs = h as unknown as HljsLike;
		})().catch(() => {
			hljsPromise = null;
		});
	}
	return hljsPromise;
}

/** Warm both heavy renderers during idle so they're ready before the first answer needs them —
 *  the eager bundle stays light (fast hydration) while the libs prefetch in the background. */
export function prefetchMarkdownAssets(): void {
	void ensureKatex();
	void ensureHljs();
}

// Media URL detection
const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|m4v)([?#]|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|flac)([?#]|$)/i;

function isVideoUrl(url: string): boolean {
	return VIDEO_EXTENSIONS.test(url);
}

function isAudioUrl(url: string): boolean {
	return AUDIO_EXTENSIONS.test(url);
}

function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url.trim());
}

// Whether the browser may fetch this URL with no click. This renderer draws model output,
// and model output can be steered by a page the model read (web search today, a fetched link next),
// so an <img>/<video>/<audio> pointed at another host is a request the page's author chose, sent the
// moment the answer appears, with whatever the model put in the URL — earlier messages included.
// Only a conversation's own files and inline data:/blob: media load on their own; any absolute URL,
// including one to our own origin, renders as a link the person has to choose to open.
// (CUR-1898)
// "relative" is not the same as "ours". `/rs/*` forwards to PostHog with whatever project
// key the URL names, and `/chat/api/fetch-url` fetches any public host with the visitor's cookie, so
// an image at either sends the conversation off-site with no click. A relative URL loads on its own
// only when it names a conversation's output file or agent artifact, and carries no query string. (CUR-3389)
// On the chat surface those live at `/conversation/...`; a `/chat/conversation/...` URL
// saved in an earlier answer still loads there (it 308s to the root form), so both are accepted. (CUR-4448)
const OWN_MEDIA_PATH = new RegExp(
	`^${base ? '\\/chat' : '(?:\\/chat)?'}\\/conversation\\/[A-Za-z0-9_-]+\\/(output|agent-artifact)\\/[^?#\\\\]+$`
);

function loadsWithoutClick(url: string): boolean {
	const u = url.trim();
	if (u.startsWith('/')) return OWN_MEDIA_PATH.test(u) && !u.includes('..');
	return /^(data:(image|video|audio)\/|blob:)/i.test(u);
}

function renderRemoteMediaAsLink(safeHref: string, text?: string | null): string {
	const label = text?.trim() ? text : safeHref;
	return `<a href="${escapeHTML(safeHref)}" target="_blank" rel="noreferrer">${escapeHTML(label)}</a>`;
}

function renderMediaTag(safeHref: string, title?: string | null, text?: string | null): string {
	const safeSrc = escapeHTML(safeHref);
	const safeTitle = title ? ` title="${escapeHTML(title)}"` : '';
	const safeAlt = escapeHTML(text ?? '');
	if (isVideoUrl(safeHref)) {
		return `<video controls${safeTitle}><source src="${safeSrc}">${safeAlt}</video>`;
	}
	if (isAudioUrl(safeHref)) {
		return `<audio controls${safeTitle}><source src="${safeSrc}">${safeAlt}</audio>`;
	}
	return `<img src="${safeSrc}" alt="${safeAlt}"${safeTitle} />`;
}

// Multimedia HTML sanitization (works in Web Workers - no DOM needed)
const MULTIMEDIA_TAGS = new Set(['video', 'source', 'audio']);
const MULTIMEDIA_ALLOWED_ATTRS = new Set([
	'src',
	'type',
	'controls',
	'autoplay',
	'loop',
	'muted',
	'playsinline',
	'poster',
	'width',
	'height',
	'preload'
]);
const MULTIMEDIA_BOOLEAN_ATTRS = new Set(['controls', 'autoplay', 'loop', 'muted', 'playsinline']);
const MULTIMEDIA_URI_ATTRS = new Set(['src', 'poster']);
const MULTIMEDIA_ALLOWED_URI_PATTERN = /^(?!javascript:|data:text\/html)/i;
const MULTIMEDIA_HTML_REGEX = /<\/?(video|source|audio)\b/i;

type HtmlNode = {
	type: string;
	name?: string;
	attribs?: Record<string, string>;
	children?: HtmlNode[];
	data?: string;
};

interface katexBlockToken extends Tokens.Generic {
	type: 'katexBlock';
	raw: string;
	text: string;
	displayMode: true;
}

interface katexInlineToken extends Tokens.Generic {
	type: 'katexInline';
	raw: string;
	text: string;
	displayMode: false;
}

export const katexBlockExtension: TokenizerExtension & RendererExtension = {
	name: 'katexBlock',
	level: 'block',

	start(src: string): number | undefined {
		const match = src.match(/(\${2}|\\\[)/);
		return match ? match.index : -1;
	},

	tokenizer(src: string): katexBlockToken | undefined {
		// 1) $$ ... $$
		const rule1 = /^\${2}([\s\S]+?)\${2}/;
		const match1 = rule1.exec(src);
		if (match1) {
			const token: katexBlockToken = {
				type: 'katexBlock',
				raw: match1[0],
				text: match1[1].trim(),
				displayMode: true
			};
			return token;
		}

		// 2) \[ ... \]
		const rule2 = /^\\\[([\s\S]+?)\\\]/;
		const match2 = rule2.exec(src);
		if (match2) {
			const token: katexBlockToken = {
				type: 'katexBlock',
				raw: match2[0],
				text: match2[1].trim(),
				displayMode: true
			};
			return token;
		}

		return undefined;
	},

	renderer(token) {
		if (token.type === 'katexBlock') {
			if (token.text.length > MAX_KATEX_LENGTH) return escapeHTML(token.raw);
			if (katexRender) {
				return katexRender(token.text, { throwOnError: false, displayMode: token.displayMode });
			}
			void ensureKatex();
			// Readable, muted fallback until KaTeX loads (the async/worker render upgrades it).
			return `<div data-katex-pending style="opacity:.55;font-family:ui-monospace,monospace">${escapeHTML(token.text)}</div>`;
		}
		return undefined;
	}
};

const katexInlineExtension: TokenizerExtension & RendererExtension = {
	name: 'katexInline',
	level: 'inline',

	start(src: string): number | undefined {
		const match = src.match(/(\$|\\\()/);
		return match ? match.index : -1;
	},

	tokenizer(src: string): katexInlineToken | undefined {
		// 1) $...$ — currency-safe inline math. A naive /^\$([^$]+?)\$/ swallows ordinary prose with
		// dollar AMOUNTS: "it costs $1 more, and together they cost $1.10" parses as math and renders
		// garbled (italicised, spaces stripped). Guard like GitHub's math extension: the opening $ must
		// NOT be followed by a space or digit (so "$1" reads as currency, not a math start), the content
		// is single-line and $-free, the closing $ must not be preceded by a space, and must not be
		// followed by a digit. Real inline math ("$x$", "$E=mc^2$") still matches; "\(...\)" is the
		// space/digit-proof alternative below.
		const rule1 = /^\$(?![\s\d])([^$\n]+?)(?<!\s)\$(?!\d)/;
		const match1 = rule1.exec(src);
		if (match1) {
			const token: katexInlineToken = {
				type: 'katexInline',
				raw: match1[0],
				text: match1[1].trim(),
				displayMode: false
			};
			return token;
		}

		// 2) \(...\)
		const rule2 = /^\\\(([\s\S]+?)\\\)/;
		const match2 = rule2.exec(src);
		if (match2) {
			const token: katexInlineToken = {
				type: 'katexInline',
				raw: match2[0],
				text: match2[1].trim(),
				displayMode: false
			};
			return token;
		}

		return undefined;
	},

	renderer(token) {
		if (token.type === 'katexInline') {
			if (token.text.length > MAX_KATEX_LENGTH) return escapeHTML(token.raw);
			if (katexRender) {
				return katexRender(token.text, { throwOnError: false, displayMode: token.displayMode });
			}
			void ensureKatex();
			return `<code data-katex-pending style="opacity:.55">${escapeHTML(token.text)}</code>`;
		}
		return undefined;
	}
};

// highlight.js and KaTeX run synchronously and can hold their thread for seconds on a huge block,
// such as a model dumping a large unlabeled code block or a giant formula. Past these sizes the block
// renders as escaped text instead (upstream 91123d1f, CUR-2647). Normal content is unaffected.
const MAX_HIGHLIGHT_LENGTH = 50_000;
// Auto-detection runs every registered grammar over the input, so it gets a tighter cap.
const MAX_AUTO_HIGHLIGHT_LENGTH = 5_000;
const MAX_KATEX_LENGTH = 10_000;

function escapeHTML(content: string) {
	return content.replace(
		/[<>&"']/g,
		(x) =>
			({
				'<': '&lt;',
				'>': '&gt;',
				'&': '&amp;',
				"'": '&#39;',
				'"': '&quot;'
			})[x] || x
	);
}

const HTML_CITATION_PROTECTED_SEGMENT =
	/<div\b[^>]*data-katex-pending[\s\S]*?<\/div>|<code\b[\s\S]*?<\/code>|<pre\b[\s\S]*?<\/pre>|<a\b[\s\S]*?<\/a>|<video\b[\s\S]*?<\/video>|<audio\b[\s\S]*?<\/audio>|<[^>]+>/gi;

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const LIST_LEADING_CITATIONS =
	/^(\s*(?:[-*+]\s+|\d{1,9}[.)]\s+))((?:\[(\d+(?:\s*,\s*\d+)*)\](?![(:])\s*)+)(\S[\s\S]*?)$/;
// A grouped marker ("[1, 2]") counts too, by its first number, so a list item's leading group moves to
// the item's end with the rest, where the inline pass links it (CUR-3299).
const CITATION_MARKER_ONLY = /\[(\d+)(?:\s*,\s*\d+)*\](?![(:])/g;

function moveMarkersBeforeTerminalPunctuation(text: string, markers: string): string {
	const trimmedMarkers = markers.trim();
	return text.replace(/(\s*)([.!?])(["')\]}>]*)$/u, ` ${trimmedMarkers}$2$3$1`);
}

function appendLineCitationMarkers(text: string, markers: string): string {
	const trimmed = text.replace(/\s+$/u, '');
	const trailing = text.slice(trimmed.length);
	const moved = /[.!?]["')\]}>]*$/u.test(trimmed)
		? moveMarkersBeforeTerminalPunctuation(trimmed, markers)
		: `${trimmed} ${markers.trim()}`;
	return moved + trailing;
}

// Mistral Large 3 cites in Pandoc's caret shapes, "Tokyo^1,2^", "[^1^]" and a "[^1^]: note" line,
// which marked prints as text. Each becomes the bracketed marker the inline pass links (CUR-3551).
const CARET_FOOTNOTE_DEFINITION = /^(\s*)\[\^(\d+)\^\]:\s*/;
// Bold or italic round nothing but citation markers, "problemas**[1][2]**." Marked can't open bold
// before "[" after a letter, so it printed both pairs of asterisks; the markers need no emphasis (CUR-2393).
const EMPHASIZED_CITATIONS = /(\*{1,2}|_{1,2})(\s*(?:\[\d+(?:\s*,\s*\d+)*\]\s*)+)\1(?![*_])/g;
const INLINE_CODE_SPAN = /(`+[^`\n]*`+)/;
// The start of one still streaming in: "Tokyo^", "Tokyo^1,2", "[^1", "Tokyo[1]-". The lookbehind
// spares the "^" that closes "^1,2,5^", which would otherwise be stripped to a raw "^1,2,5" (CUR-4124);
// its digit keeps "^1^ ^2" holding back the second group's opener.
const CARET_CITATION_TAIL = /(?:\[\^[\d,\s]*\^?|(?<!\^[\d,\s]*\d[\d,\s]*)\^[\d,\s]*|\[\d+\]\s*[-–]\s*\d*)$/;

function normalizeCaretCitations(md: string, sources: SimpleSource[] = []): string {
	if (!sources.length || !/[\^\]]/.test(md)) return md;
	let inFence = false;
	return md
		.split(/(\r?\n)/)
		.map((part) => {
			if (part === '\n' || part === '\r\n') return part;
			if (FENCE_LINE.test(part)) {
				inFence = !inFence;
				return part;
			}
			if (inFence) return part;
			return part
				.replace(CARET_FOOTNOTE_DEFINITION, '$1[$2] ')
				.split(INLINE_CODE_SPAN)
				.map((segment, i) =>
					i % 2
						? segment
						: bracketCitations(segment).replace(EMPHASIZED_CITATIONS, (_, __, markers: string) =>
								markers.trim()
							)
				)
				.join('');
		})
		.join('');
}

/** Mid-stream, holds back a caret citation that hasn't closed yet, so "Tokyo^" never shows. */
function holdBackCaretCitationTail(md: string, sources: SimpleSource[]): string {
	return sources.length ? md.replace(CARET_CITATION_TAIL, '') : md;
}

function normalizeLeadingListCitations(md: string, sources: SimpleSource[] = []): string {
	if (!sources.length || !md.includes('[')) return md;
	let inFence = false;
	return md
		.split(/(\r?\n)/)
		.map((part) => {
			if (part === '\n' || part === '\r\n') return part;
			if (FENCE_LINE.test(part)) {
				inFence = !inFence;
				return part;
			}
			if (inFence) return part;
			const match = part.match(LIST_LEADING_CITATIONS);
			if (!match) return part;
			const [, prefix, markers, , body] = match;
			CITATION_MARKER_ONLY.lastIndex = 0;
			const hasKnownSource = [...markers.matchAll(CITATION_MARKER_ONLY)].some((m) => {
				const n = Number(m[1]);
				return n >= 1 && n <= sources.length;
			});
			if (!hasKnownSource) return part;
			return prefix + appendLineCitationMarkers(body, markers);
		})
		.join('');
}

function addInlineCitations(md: string, webSearchSources: SimpleSource[] = []): string {
	// Baseline bracketed reference markers — e.g. [1] or [1][2] — NOT a raised <sup>. A superscript
	// floats orphaned when the answer is a summary rather than inline-cited prose (a lone raised digit
	// reads as a typo when citations are sparse). Bracketed baseline links also match
	// the SourceStrip's own "[n]" notation, so the inline marker and the source list read as one
	// system. Brand coral (themeable var), not the old off-palette generic blue.
	const linkStyle =
		'color: var(--ap-live-text); text-decoration: none; font-size: 0.82em; vertical-align: baseline; letter-spacing: 0.02em;';
	// Non-link marker for a source that has NO url (e.g. local-knowledge / RAG catalog entries): muted
	// ink, not coral, so it doesn't read as clickable. A url-less source used to render as
	// `<a href="">[n]</a>` — a link that LOOKS clickable but goes nowhere (or reloads the page); a
	// static marker is the honest rendering when there's nowhere to navigate.
	const markerStyle =
		'color: var(--ap-ink-3); font-size: 0.82em; vertical-align: baseline; letter-spacing: 0.02em;';
	const masks: string[] = [];
	const masked = md.replace(HTML_CITATION_PROTECTED_SEGMENT, (match) => {
		masks.push(match);
		return `\u0000${masks.length - 1}\u0000`;
	});
	// A run of markers is rewritten as one, in entry numbers: sources sharing a url show as one entry,
	// so "[1][2]" over two chunks of one page reads "[1]" (collapseSources.ts, CUR-888).
	// Cited pages are numbered first, in the order the whole answer cites them (CUR-3933). The rank comes
	// from the message, since this sees one block of it at a time.
	const citedFirst = webSearchSources
		.flatMap((s, i) => (s.citedRank === undefined ? [] : [[s.citedRank, i + 1]]))
		.sort((a, b) => a[0] - b[0])
		.map(([, n]) => n);
	const { entries, display } = collapseSources(webSearchSources, citedFirst);
	// A marker may group numbers, "[1,3]" or "[1, 3]", and each number becomes its own link (CUR-3246).
	// A grouped one is also how prose writes an interval or a list ("the interval [1, 2] is closed"), so
	// it links only where a citation sits, at the end of a clause: followed by punctuation, a line end
	// or nothing. One followed by more words on its line stays text (CUR-3299). A lone "[1]" is not
	// held to this, as it linked before grouping did.
	const linked = masked.replace(
		/\[\d+(?:\s*,\s*\d+)*\](?:\s*\[\d+(?:\s*,\s*\d+)*\])*/g,
		(match: string, offset: number, whole: string) => {
			if (match.includes(',') && /^[ \t]*[\p{L}\p{N}]/u.test(whole.slice(offset + match.length))) {
				return match;
			}
			const indices: number[] = collapseMarkerRun((match.match(/\d+/g) || []).map(Number), display);
			const links: string = indices
				.map((index: number) => {
					if (index === 0) return false;
					const source = entries[index - 1];
					if (source?.link) {
						return `<a href="${escapeHTML(source.link)}" target="_blank" rel="noreferrer" style="${linkStyle}">[${index}]</a>`;
					}
					if (source) {
						// Source exists but carries no url (RAG catalog / admin-uploaded docs). Show the document
						// NAME as a non-link marker so the reader sees where the claim came from — never a dead
						// link, and never a bare [n] that reads as clickable-but-broken. Falls back to the index
						// only if a source somehow has no title.
						const label = source.title ? escapeHTML(source.title) : String(index);
						return `<span style="${markerStyle}">[${label}]</span>`;
					}
					return '';
				})
				.filter(Boolean)
				.join('');
			// Hair space keeps the marker from kerning into the preceding word; nowrap keeps it on the
			// same line as that word so a citation never wraps to a line on its own.
			return links ? `<span style="white-space:nowrap;">&#8202;${links}</span>` : match;
		}
	);
	// The NUL sentinels are the point, not an accident: masked spans are stashed behind a delimiter
	// that cannot occur in markdown source, so the linkifier above cannot match inside one. That
	// impossibility is what makes the mask safe, and it is why the control character stays.
	// eslint-disable-next-line no-control-regex
	return linked.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)]);
}

// The schemes a rendered link may carry. Anything else, `javascript:` and `vbscript:` included, renders
// as text. A denylist of bad schemes lost to `java\tscript:` (CUR-3515).
const ALLOWED_HREF_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The URL as the browser will resolve it: the WHATWG parser drops ASCII tab and newline anywhere and
 * leading/trailing C0 controls and spaces, so the scheme check has to look at the same string.
 */
function normalizeUrl(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

/** The scheme the browser will read from `url`, lowercased, or null for a relative URL. */
function urlScheme(url: string): string | null {
	const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
	return match ? match[1].toLowerCase() : null;
}

/** An inline image, video or audio payload, which only an image source may carry. */
const INLINE_MEDIA_URL = /^(data:(image|video|audio)\/|blob:)/i;

function sanitizeHref(href?: string | null, { media = false } = {}): string | undefined {
	if (!href) return undefined;
	const url = normalizeUrl(href).replace(/>$/, '');
	if (!url) return undefined;
	if (media && INLINE_MEDIA_URL.test(url)) return url;
	const scheme = urlScheme(url);
	if (scheme !== null && !ALLOWED_HREF_SCHEMES.has(scheme)) return undefined;
	return url;
}

export function highlightCode(text: string, lang?: string): string {
	if (text.length > MAX_HIGHLIGHT_LENGTH) return escapeHTML(text);
	if (!hljs) {
		void ensureHljs();
		// Plain (but fully readable) code until highlight.js loads; the worker render adds colors.
		return escapeHTML(text);
	}
	if (lang && hljs.getLanguage(lang)) {
		try {
			return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
		} catch {
			// fall through to auto-detect
		}
	}
	if (text.length > MAX_AUTO_HIGHLIGHT_LENGTH) return escapeHTML(text);
	return hljs.highlightAuto(text).value;
}

function sanitizeMediaUrl(value: string): string | undefined {
	const trimmed = normalizeUrl(value).replace(/>$/, '');
	if (!MULTIMEDIA_ALLOWED_URI_PATTERN.test(trimmed)) return undefined;
	// A remote src or poster loads as soon as the tag renders (CUR-1898), so it is dropped.
	if (!loadsWithoutClick(trimmed)) return undefined;
	return trimmed;
}

function serializeMediaAttributes(attribs?: Record<string, string>): string {
	if (!attribs) return '';
	const parts: string[] = [];
	for (const [rawName, rawValue] of Object.entries(attribs)) {
		const name = rawName.toLowerCase();
		if (!MULTIMEDIA_ALLOWED_ATTRS.has(name)) continue;
		if (MULTIMEDIA_BOOLEAN_ATTRS.has(name)) {
			parts.push(name);
			continue;
		}
		let value = rawValue ?? '';
		if (MULTIMEDIA_URI_ATTRS.has(name)) {
			const safeUrl = sanitizeMediaUrl(value);
			if (!safeUrl) {
				// Kept as an inert data attribute so linkifyUnplayableMedia can offer it as a link.
				if (name === 'src' && isHttpUrl(value)) {
					parts.push(`data-blocked-src="${escapeHTML(value.trim())}"`);
				}
				continue;
			}
			value = safeUrl;
		}
		parts.push(`${name}="${escapeHTML(value)}"`);
	}
	return parts.length ? ` ${parts.join(' ')}` : '';
}

type MediaSerializeState = { hasDisallowedTag: boolean; closedInInput: Set<string> };

function serializeMediaNode(node: HtmlNode, state: MediaSerializeState): string {
	if (node.type === 'text') {
		return escapeHTML(node.data ?? '');
	}
	if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
		const tagName = node.name?.toLowerCase() ?? '';
		if (!MULTIMEDIA_TAGS.has(tagName)) {
			state.hasDisallowedTag = true;
			return '';
		}
		const attrs = serializeMediaAttributes(node.attribs);
		if (tagName === 'source') {
			return `<source${attrs}>`;
		}
		const children = (node.children ?? [])
			.map((child) => serializeMediaNode(child, state))
			.join('');
		// marked passes `<video controls>`, each `<source>` and `</video>` as separate tokens.
		// htmlparser2 closes an open tag at the end of its input, so closing it here would emit
		// an empty player with the sources outside it. Close only what the input itself closed.
		const close = state.closedInInput.has(tagName) ? `</${tagName}>` : '';
		return `<${tagName}${attrs}>${children}${close}`;
	}
	if (node.type === 'comment') {
		return '';
	}
	return '';
}

// marked hands the sanitizer one tag at a time, so only the whole rendered block shows whether a
// <video>/<audio> kept any src. One that kept none is an empty player (CUR-1898), so it becomes a
// link to each remote source that was dropped, or nothing when there was none. This matches only
// the tags serializeMediaNode itself emits.
const MEDIA_ELEMENT_RE = /<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const BLOCKED_SRC_RE = /data-blocked-src="([^"]*)"/g;

// A player the block opens and never closes would take the rest of the block as its fallback
// content, hidden from the reader (CUR-2901). Close it right after its own <source> tags. Only the
// whole block can say it is unclosed: marked hands the sanitizer `<video>` and `</video>` apart.
// Opens and closes are paired in order, so a later player's close never stands in for an earlier one.
const MEDIA_TAG_RE = /<(\/?)(video|audio)\b[^>]*>(?:\s*<source\b[^>]*>)*/gi;

function closeUnclosedMedia(html: string): string {
	const open: { tag: string; end: number }[] = [];
	const unclosed: { tag: string; end: number }[] = [];
	for (const m of html.matchAll(MEDIA_TAG_RE)) {
		const tag = m[2].toLowerCase();
		if (!m[1]) {
			open.push({ tag, end: (m.index ?? 0) + m[0].length });
			continue;
		}
		const i = open.findLastIndex((o) => o.tag === tag);
		if (i >= 0) unclosed.push(...open.splice(i).slice(1));
	}
	unclosed.push(...open);
	return unclosed
		.sort((a, b) => b.end - a.end)
		.reduce((out, { tag, end }) => `${out.slice(0, end)}</${tag}>${out.slice(end)}`, html);
}

function linkifyUnplayableMedia(rendered: string): string {
	if (!rendered.includes('data-blocked-src') && !MULTIMEDIA_HTML_REGEX.test(rendered))
		return rendered;
	const html = closeUnclosedMedia(rendered);
	return html.replace(MEDIA_ELEMENT_RE, (element, tag: string, attrs: string, inner: string) => {
		// Text inside a player is fallback content, which a browser that plays the tag never shows. An
		// answer that wraps a sentence in one meant it to be read, so it goes after the player instead.
		const sources = inner.match(/<source\b[^>]*>/gi)?.join('') ?? '';
		const text = inner.replace(/<source\b[^>]*>/gi, '').trim();
		const after = text ? ` ${text}` : '';
		if (/\ssrc="/.test(element))
			return `<${tag}${attrs}>${sources}</${tag}>`.replace(/ data-blocked-src="[^"]*"/g, '') + after;
		const links = [...element.matchAll(BLOCKED_SRC_RE)].map(
			([, href]) => `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`
		);
		return (links.join(' ') + after).trim();
	});
}

/**
 * Sanitizes HTML to allow only video/audio/source tags with safe attributes.
 * Uses htmlparser2 which works in Web Workers (no DOM needed).
 * If any disallowed tags are found, escapes the entire input.
 */
function sanitizeHtmlForMultimedia(html: string): string {
	if (!MULTIMEDIA_HTML_REGEX.test(html)) {
		return escapeHTML(html);
	}
	const document = parseDocument(html, {
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		recognizeSelfClosing: true
	}) as unknown as { children: HtmlNode[] };
	const loneClose = /^\s*<\/(video|audio)\s*>\s*$/i.exec(html);
	if (loneClose) return `</${loneClose[1].toLowerCase()}>`;
	const closedInInput = new Set(
		[...html.matchAll(/<\/(video|audio)\s*>/gi)].map((m) => m[1].toLowerCase())
	);
	const state: MediaSerializeState = { hasDisallowedTag: false, closedInInput };
	const sanitized = (document.children ?? [])
		.map((child) => serializeMediaNode(child, state))
		.join('');
	if (state.hasDisallowedTag) {
		return escapeHTML(html);
	}
	return sanitized;
}

// Each block of an answer carries its own direction (textDirection.ts decides it). Without
// one, an Arabic, Urdu or Pashto answer inherits the page's left-to-right, so a trailing full stop or an
// embedded Latin name ("AI Potluck") lands at the wrong end of the line. It goes on every block rather
// than once on the message, so an English answer quoting an Arabic paragraph lays that paragraph out
// right to left. A list, item, quote or table is decided over its whole content, so its bullets and
// indent sit on the side its text reads from.
//
// carry their own dir, so a <ul dir="auto"> of Urdu items with their own dir resolves left to right.
// CI. Marked emits these tags bare or with attributes after a space, and escapes any "<p" inside code,
// so only real tags match. (CUR-1917)
const DIRECTION_BLOCKS = /<(p|h[1-6]|td|th|ul|ol|li|blockquote|table)(?=[\s>])/g;

/** The block's own HTML, from its opening tag to its matching close (nested same-name tags counted). */
function blockHtml(html: string, offset: number, tag: string): string {
	const tags = new RegExp(`<(/?)${tag}(?=[\\s>])`, 'g');
	tags.lastIndex = offset + 1;
	let depth = 1;
	for (let m = tags.exec(html); m; m = tags.exec(html)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return html.slice(offset, m.index);
	}
	return html.slice(offset);
}

function withTextDirection(html: string): string {
	return html.replace(DIRECTION_BLOCKS, (_, tag: string, offset: number) => {
		const dir = htmlTextDirection(blockHtml(html, offset, tag));
		return dir === 'auto' ? `<${tag}` : `<${tag} dir="${dir}"`;
	});
}

function createMarkedInstance(sources: SimpleSource[]): Marked {
	return new Marked({
		hooks: {
			// Mark inline `code` spans translate="no" so browser auto-translate (DE/FR readers)
			// doesn't rewrite identifiers/commands/model names into the target language. Fenced
			// blocks are tokenized out to CodeBlock.svelte (protected there), so the only <code>
			// left in this prose HTML is inline codespans — a plain replace is safe + signature-
			// independent (no marked renderer-override needed). Default marked emits bare <code>.
			postprocess: (html) =>
				withTextDirection(
					addInlineCitations(linkifyUnplayableMedia(html), sources).replaceAll(
						'<code>',
						'<code translate="no">'
					)
				)
		},
		extensions: [katexBlockExtension, katexInlineExtension],
		// NOTE ON SIGNATURES (marked 13+): built-in renderer overrides take ONE token, not positional
		// args, and must be `function` rather than arrow so `this.parser` resolves. The link text is
		// derived with `this.parser.parseInline(token.tokens)` — that is deliberate and load-bearing.
		// It returns already-escaped inline HTML (marked 15 moved escaping out of the tokenizers and
		// into the renderers, so it happens during this call), which is why the branches below can
		// interpolate it raw. `token.text` would be the RAW markdown source, and interpolating that
		// would emit whatever the model wrote, on the surface that renders untrusted model output.
		// marked.spec.ts's "link renderer escapes its text" block is the guard.
		renderer: {
			link(token) {
				const { href, title } = token;
				const text = this.parser.parseInline(token.tokens);
				// Placeholder emitted by parseIncompleteMarkdown while a link's URL is
				// still streaming in: render an inert anchor instead of a dead link.
				if (href === 'streamdown:incomplete-link') {
					return `<a data-incomplete-link>${text}</a>`;
				}
				// Unverified-URL flag from $lib/chat/server/urlGuard (CURRENT scheme): the model emitted a citation
				// URL we can't vouch for. Keep it a NORMAL clickable link (real href) but mark it — dotted
				// underline + a "?" button into the explanation — so a real link still works (a fabricated one
				// honestly 404s) while being visibly flagged. a11y: the dotted style is visual-only, so the
				// link's accessible name carries a visually-hidden "(unverified link)"; the "?" is a real
				// keyboard-operable button (ChatMessage handles Enter/Space on [data-uv-mark]) sitting OUTSIDE
				// the anchor so activating it opens the explanation instead of navigating.
				if (title === UNVERIFIED_TITLE) {
					const safeHref = sanitizeHref(href);
					if (!safeHref) return `<span>${escapeHTML(text ?? '')}</span>`;
					const tip =
						"Generated link — the chat didn't retrieve or verify this page this turn. It's clickable, but treat it with caution.";
					const linkStyle =
						'text-decoration: underline dotted var(--ap-ink-3); text-underline-offset: 2px;';
					const markStyle =
						'color: var(--ap-gap); font-size: 0.72em; vertical-align: super; margin-left: 1px; font-weight: 600; cursor: pointer;';
					return (
						`<a class="uv-link" href="${escapeHTML(safeHref)}" target="_blank" rel="noreferrer" style="${linkStyle}" title="${escapeHTML(tip)}">` +
						`${text}<span class="sr-only"> (unverified link)</span></a>` +
						`<sup class="uv-mark" style="${markStyle}" data-uv-mark role="button" tabindex="0" aria-label="Why this link is marked unverified">?</sup>`
					);
				}
				// LEGACY sentinel: older persisted messages have the href itself overwritten,
				// so the real URL is gone — render the non-navigating, "?"-marked reference they were saved as.
				if (href === UNVERIFIED_HREF) {
					const tip =
						'Generated link — not retrieved or verified this turn. The chat only leaves a link clickable when it retrieved the page or recognises the domain.';
					const linkStyle =
						'color: var(--ap-ink-2); text-decoration: underline dotted var(--ap-ink-3); text-underline-offset: 2px; cursor: help;';
					// The "?" is a button into the explanation: ChatMessage delegates clicks on [data-uv-mark]
					// to scroll/flash the UrlNotice chip. cursor:pointer + role/tabindex make that discoverable
					// and keyboard-reachable.
					const markStyle =
						'color: var(--ap-gap); font-size: 0.72em; vertical-align: super; margin-left: 1px; font-weight: 600; cursor: pointer;';
					return `<span class="uv-link" style="${linkStyle}" title="${escapeHTML(tip)}">${text}<sup class="uv-mark" style="${markStyle}" data-uv-mark role="button" tabindex="0" aria-label="Why this link isn't clickable">?</sup></span>`;
				}
				const safeHref = sanitizeHref(href);
				// `text` is already-escaped inline HTML, so it goes in raw. Escaping it again is what
				// made this branch emit `&amp;lt;img …` — the literal entity text — under marked 12.
				if (!safeHref) return `<span>${text}</span>`;
				// A link to a media file stays a link. Promoting it to an inline player made the browser
				// fetch it unasked, which is the CUR-1898 channel; a relative one is never promoted either,
				// since the model has no reason to link our own files as media.
				return `<a href="${escapeHTML(safeHref)}" target="_blank" rel="noreferrer">${text}</a>`;
			},
			image(token) {
				// Placeholder emitted by parseIncompleteMarkdown (remend 1.4+) while an image's URL is
				// still streaming in: render nothing until the real URL arrives (CUR-4279).
				if (token.href === 'streamdown:incomplete-image') return '';
				const safeHref = sanitizeHref(token.href, { media: true });
				// token.text is the raw alt text; both sinks escape it exactly once.
				if (!safeHref) return `<span>${escapeHTML(token.text)}</span>`;
				if (!loadsWithoutClick(safeHref)) {
					return isHttpUrl(safeHref)
						? renderRemoteMediaAsLink(safeHref, token.text)
						: `<span>${escapeHTML(token.text)}</span>`;
				}
				return renderMediaTag(safeHref, token.title, token.text);
			},
			// Called for both block `html` tokens and inline `Tag` tokens in marked 13+; both carry the
			// raw markup on `.text`.
			html(token) {
				return sanitizeHtmlForMultimedia(token.text);
			}
		},
		gfm: true,
		breaks: true
	});
}
function isFencedBlockClosed(raw?: string): boolean {
	if (!raw) return true;
	/* eslint-disable-next-line no-control-regex */
	const trimmed = raw.replace(/[\s\u0000]+$/, '');
	const openingFenceMatch = trimmed.match(/^([`~]{3,})/);
	if (!openingFenceMatch) {
		return true;
	}
	const fence = openingFenceMatch[1];
	const closingFencePattern = new RegExp(`(?:\n|\r\n)${fence}(?:[\t ]+)?$`);
	return closingFencePattern.test(trimmed);
}

type CodeToken = {
	type: 'code';
	lang: string;
	code: string;
	rawCode: string;
	isClosed: boolean;
};

type TextToken = {
	type: 'text';
	html: string | Promise<string>;
};

const blockCache = new Map<string, BlockToken>();

function cacheKey(index: number, blockContent: string, sources: SimpleSource[]) {
	// The rank as well as the link: the same block renders other numbers when the message cites in another order.
	const sourceKey = sources.map((s) => `${s.link}#${s.citedRank ?? ''}`).join('|');
	return `${index}-${hashString(blockContent)}|${sourceKey}`;
}

export async function processTokens(content: string, sources: SimpleSource[]): Promise<Token[]> {
	// Full-fidelity render (the worker / no-worker async path). Load only what THIS content needs,
	// then render — so a plain-text answer never pulls KaTeX/highlight.js, and KaTeX loads only when
	// a math delimiter is actually present (lazy KaTeX). The sync path already painted a readable
	// fallback; awaiting here is what upgrades it.
	const needsMath = /\$|\\\(/.test(content);
	const needsCode = content.includes('```') || content.includes('~~~') || content.includes('`');
	await Promise.all([needsMath ? ensureKatex() : undefined, needsCode ? ensureHljs() : undefined]);

	const marked = createMarkedInstance(sources);
	const tokens = marked.lexer(
		normalizeLeadingListCitations(normalizeCaretCitations(content, sources), sources)
	);

	const processedTokens = await Promise.all(
		tokens.map(async (token) => {
			if (token.type === 'code') {
				return {
					type: 'code' as const,
					lang: token.lang,
					code: highlightCode(token.text, token.lang),
					rawCode: token.text,
					isClosed: isFencedBlockClosed(token.raw ?? '')
				};
			} else {
				return {
					type: 'text' as const,
					html: marked.parse(token.raw)
				};
			}
		})
	);

	return processedTokens;
}

export function processTokensSync(content: string, sources: SimpleSource[]): Token[] {
	const marked = createMarkedInstance(sources);
	const tokens = marked.lexer(
		normalizeLeadingListCitations(normalizeCaretCitations(content, sources), sources)
	);
	return tokens.map((token) => {
		if (token.type === 'code') {
			return {
				type: 'code' as const,
				lang: token.lang,
				code: highlightCode(token.text, token.lang),
				rawCode: token.text,
				isClosed: isFencedBlockClosed(token.raw ?? '')
			};
		}
		return { type: 'text' as const, html: marked.parse(token.raw) };
	});
}

export type Token = CodeToken | TextToken;

export type BlockToken = {
	id: string;
	content: string;
	tokens: Token[];
};

/**
 * Simple hash function for generating stable block IDs
 */
function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return Math.abs(hash).toString(36);
}

/**
 * Process markdown content into blocks with stable IDs for efficient memoization.
 * Each block is processed independently and assigned a content-based hash ID.
 *
 * `streaming` applies incomplete-markdown repairs (remend) to the content before
 * splitting, like upstream streamdown does in streaming mode. It must be false for
 * completed messages so valid final markdown (e.g. a trailing setext heading) is
 * not rewritten by the streaming flash guards. Completed messages instead get
 * `finalizeMarkdown`, which repairs the two malformed shapes remend leaves behind
 * at completion (run-on `N. **` lists, dangling `**`) so formatting doesn't
 * "settle" back to raw literal markdown when streaming ends. See finalizeMarkdown.ts.
 */
export async function processBlocks(
	content: string,
	sources: SimpleSource[] = [],
	streaming = false
): Promise<BlockToken[]> {
	const unwrapped = unwrapMarkdownFences(content);
	const processedContent = streaming
		? parseIncompleteMarkdown(holdBackCaretCitationTail(unwrapped, sources))
		: finalizeMarkdown(unwrapped);
	const blocks = parseMarkdownIntoBlocks(processedContent);

	return await Promise.all(
		blocks.map(async (blockContent, index) => {
			const key = cacheKey(index, blockContent, sources);
			const cached = blockCache.get(key);
			if (cached) return cached;

			const tokens = await processTokens(blockContent, sources);
			const block: BlockToken = {
				id: `${index}-${hashString(blockContent)}`,
				content: blockContent,
				tokens
			};
			blockCache.set(key, block);
			return block;
		})
	);
}

/**
 * Synchronous version of processBlocks for SSR
 */
export function processBlocksSync(
	content: string,
	sources: SimpleSource[] = [],
	streaming = false
): BlockToken[] {
	const unwrapped = unwrapMarkdownFences(content);
	const processedContent = streaming
		? parseIncompleteMarkdown(holdBackCaretCitationTail(unwrapped, sources))
		: finalizeMarkdown(unwrapped);
	const blocks = parseMarkdownIntoBlocks(processedContent);

	return blocks.map((blockContent, index) => {
		const key = cacheKey(index, blockContent, sources);
		const cached = blockCache.get(key);
		if (cached) return cached;

		const tokens = processTokensSync(blockContent, sources);
		const block: BlockToken = {
			id: `${index}-${hashString(blockContent)}`,
			content: blockContent,
			tokens
		};
		// A block drawn before highlight.js or KaTeX loaded is the plain stand-in. Caching it would hand
		// it to processBlocks, which reads the same cache, so a reopened chat's code never got colours.
		if (!renderedBeforeLoad(tokens)) blockCache.set(key, block);
		return block;
	});
}

function renderedBeforeLoad(tokens: Token[]): boolean {
	return tokens.some((t) =>
		t.type === 'code' ? !hljs : String(t.html).includes('data-katex-pending')
	);
}
