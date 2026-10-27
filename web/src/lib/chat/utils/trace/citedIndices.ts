// Which [n] source numbers an answer actually cites — pure + NOT under $lib/chat/server (same reason as
// responseDisposition.ts: ProvenanceTrace.svelte is a client component and needs this at render time).
//
// Read-only sibling of $lib/chat/server/citationGuard's stripDanglingCitations: same protected-span masking
// (a [n] inside a fenced/inline code block or a markdown link/reference is not a citation), but this
// only COLLECTS indices instead of mutating text, so the trace's source lists can mute a row the model
// never actually cited rather than hiding or stripping it.

const PROTECTED_SPAN = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g;
const MARKER = / ?\[(\d+)\](?![(:])/g;

/** The set of `[n]` numbers cited in `text` (empty when there are none, including ungrounded prose). */
export function extractCitedIndices(text: string): Set<number> {
	const original = text ?? '';
	if (!original.includes('[')) return new Set();
	const masked = original.replace(PROTECTED_SPAN, '');
	const cited = new Set<number>();
	for (const m of masked.matchAll(MARKER)) cited.add(Number(m[1]));
	return cited;
}

// "Qatar \[1,3,4\]." escapes the brackets, and "\[" opens display math, so the markers showed as a dim
// monospace line. Unescaped, the inline pass links them (CUR-3551).
const ESCAPED_CITATION = /\\\[(\d+(?:\s*,\s*\d+)*)\\\]/g;
// Some models cite in Pandoc's caret shapes, "Tokyo^1,2^" and "[^1^]", which marked prints as text (CUR-3551).
const CARET_CITATION = /\[\^(\d+(?:\s*[,\-–]\s*\d+)*)\^\]|\^(\d+(?:\s*[,\-–]\s*\d+)*)\^/g;
// A range of sources, "Tokyo[1]-4." or "[1-4]", at the end of a clause; mid-sentence a bracketed
// range is more often an interval in prose. The inline pass links "[1]" and printed "-4" (CUR-3551).
const CITATION_RANGE =
	/\[(\d+)\]\s*[-–]\s*(\d+)(?=\s*(?:[.,;:!?)]|$))|\[(\d+)\s*[-–]\s*(\d+)\](?=\s*(?:[.,;:!?)]|$))/g;
// Longer than this, a "range" is a number, not a run of sources.
const MAX_CITATION_RANGE = 20;

function expandCitationRange(match: string, ...groups: (string | undefined)[]): string {
	const [from, to] = [groups[0] ?? groups[2], groups[1] ?? groups[3]].map(Number);
	if (!(from < to && to - from < MAX_CITATION_RANGE)) return match;
	return Array.from({ length: to - from + 1 }, (_, i) => `[${from + i}]`).join('');
}

/**
 * Rewrites every citation shape an answer uses (escaped, caret, range) as plain "[n]" or "[n,m]" markers.
 * The renderer links what this returns, and `citationOrder` ranks it, so the two cannot disagree (CUR-3933).
 */
export function bracketCitations(text: string): string {
	return text
		.replace(ESCAPED_CITATION, '[$1]')
		.replace(CARET_CITATION, (_, a, b) => `[${a ?? b}]`)
		.replace(CITATION_RANGE, expandCitationRange);
}

// After bracketCitations, every citation is "[1]" or a group "[1,3]".
const ANY_MARKER = /\[(\d+(?:\s*,\s*\d+)*)\](?![(:])/g;

/**
 * The source numbers an answer cites, in the order it first cites each (CUR-3933). Reads the caret, group
 * and range shapes too, since the renderer links all of them (marked.ts), and the page numbers its
 * citations by this order.
 */
export function citationOrder(text: string): number[] {
	const masked = bracketCitations((text ?? '').replace(PROTECTED_SPAN, ''));
	const order = new Set<number>();
	for (const m of masked.matchAll(ANY_MARKER)) {
		for (const n of m[1].split(',')) order.add(Number(n.trim()));
	}
	return [...order];
}
