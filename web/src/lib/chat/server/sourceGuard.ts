// Fabricated-source guard — the runtime strip for the worst confabulation: the model inventing a
// "Sources:" bibliography (made-up titles/dates) and/or admitting the sources are fictional.
//
// The failure case is a GROUNDED web-search turn: a real search runs, but the model ignores the
// retrieved sources, appends its own fabricated "Sources:" list (blog posts with invented dates), and
// tacks on "these sources are fictional/hypothetical examples". This is a core-thesis violation — the product can never present fictional sources.
//
// The grounding prompt (searchGrounding.ts) ALREADY forbids this verbatim ("Answer using ONLY the
// information in these sources", "do NOT append a 'Sources' list", "do not fill the gap from memory"),
// yet a model can ignore all of it (see hedgeGuard: prompt counter-instructions wash out). So enforcement must be a deterministic runtime test + strip, OUT of the
// prompt. Same family as hedgeGuard / urlGuard.
//
// Two strips:
//   1. The "fictional/hypothetical/illustrative sources" DISCLAIMER — never acceptable on any turn.
//   2. A trailing "Sources:/References:/Bibliography:" block — on GROUNDED turns the real sources are
//      rendered separately as provenance chips, and the prompt forbids a body list, so a trailing list
//      is at best a duplicate and at worst fabricated. Removed only on grounded turns (conservative).
//
// Pure + side-effect-free for unit testing and reuse by the eval harness. Never returns an empty answer.

export interface FabricatedSourceResult {
	/** the answer carried a fictional-source disclaimer and/or a fabricated trailing source list */
	flagged: boolean;
	/** text with the offending disclaimer sentences and/or trailing source block removed — or the
	 *  ORIGINAL when a safe strip isn't possible (stripping would gut the answer). Never empty. */
	cleaned: string;
}

export interface SourceGuardOptions {
	/** true when the turn was grounded (web search / RAG). Only then is a trailing "Sources:" block
	 *  stripped — the real sources render separately. The fictional disclaimer is stripped regardless. */
	grounded?: boolean;
}

// Sentence-level disclaimers admitting the sources/citations are not real. Each matches a sentence whose
// PURPOSE is to flag fabricated/illustrative sourcing — the thing that must never reach the user. Kept
// sentence-scoped so we only ever drop a whole disclaiming sentence, never mangle a substantive one.
const DISCLAIMER_PATTERNS: RegExp[] = [
	// "these/the/those/above/following/provided sources|citations|references|examples ARE/WERE ... fictional|
	//  hypothetical|illustrative|made-up|fabricated|invented|not real|placeholder|examples"
	/\b(?:these|the|those|above|following|provided)\s+(?:sources?|citations?|references?|examples?)\b[^.!?]*\b(?:fiction(?:al)?|hypothetical|illustrative|made[- ]up|fabricated|invented|not\s+real|placeholder|are\s+examples?|example\s+(?:only|sources?))\b/i,
	// the reverse order: "... sources are fictional", "citations provided are hypothetical"
	/\b(?:sources?|citations?|references?)\b[^.!?]*\b(?:are|were|provided)\b[^.!?]*\b(?:fiction(?:al)?|hypothetical|illustrative|made[- ]up|fabricated|invented|not\s+real)\b/i,
	// bare "fictional examples" / "hypothetical examples" / "illustrative examples" used as the sourcing
	/\b(?:fiction(?:al)|hypothetical|illustrative|made[- ]up|fabricated)\s+examples?\b/i,
	// "for illustrative purposes" / "to demonstrate the format" style admissions tied to sources
	/\b(?:sources?|citations?|references?)\b[^.!?]*\bfor\s+illustrative\s+purposes\b/i,
];

const isDisclaimerSentence = (s: string): boolean => DISCLAIMER_PATTERNS.some((re) => re.test(s));

// A trailing bibliography heading: a line that is just "Sources" / "References" / "Bibliography" /
// "Works Cited" / "Citations", optionally markdown-decorated (#, **, __) and optionally colon-terminated.
// Anchored to a whole line so it never matches the word mid-sentence ("our sources say…").
const SOURCE_HEADING =
	/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:sources?|references?|bibliography|works\s+cited|citations?)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*$/i;

// An INLINE standalone "Sources:" label — at the start, on its own line, or right after a sentence
// boundary (NOT the tail of a prose sentence like "…covers three sources:") — that introduces a body
// dump on the SAME line ("…done. Sources: [1] https://… Title – Pub"). Group 1 is the boundary prefix,
// so a cut at (index + group-1 length) keeps the preceding sentence and drops the label onward.
const INLINE_SOURCE_LABEL =
	/((?:^|\n|[.!?]["'’”)\]]*\s+))(?:\*\*|__|#{1,6}[ \t]*)*(?:sources?|references?|bibliography|works\s+cited|citations?)[ \t]*:/gi;

const splitSentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);

// Don't return a gutted answer — if stripping leaves less than this, keep the original (the fabricated
// block is bad, but a one-word fragment is worse, and a near-total strip signals an over-broad match).
const MIN_KEEP_CHARS = 24;

/**
 * Detect a fabricated source bibliography and/or a fictional-source disclaimer in an answer and return a
 * cleaned copy. The disclaimer strip runs on every turn; the trailing "Sources:" block strip runs only on
 * grounded turns (opts.grounded), where the real sources render separately. Never returns an empty answer:
 * when a safe strip isn't possible, `cleaned` is the original and the caller can leave the answer untouched
 * while still recording `flagged`.
 */
export function detectFabricatedSources(
	text: string,
	opts: SourceGuardOptions = {}
): FabricatedSourceResult {
	const original = text ?? "";
	if (!original.trim()) return { flagged: false, cleaned: original };

	let working = original;
	let flagged = false;

	// 1. Trailing bibliography block (grounded only): cut from a "Sources:"-style heading line to EOF.
	// Split on all newline forms (incl. CRLF) so a "\r\n## Sources:" heading isn't tested as
	// "## Sources:\r" — the trailing \r would otherwise defeat SOURCE_HEADING's [ \t]-only allowance.
	if (opts.grounded) {
		const lines = working.split(/\r?\n/);
		const headingIdx = lines.findIndex((l) => SOURCE_HEADING.test(l));
		if (headingIdx > 0) {
			const head = lines.slice(0, headingIdx).join("\n").trimEnd();
			if (head.length >= MIN_KEEP_CHARS) {
				working = head;
				flagged = true;
			}
		}
	}

	// 1b. An INLINE standalone "Sources:" label introducing a body dump on the same line (the line-based
	// check above only catches a label on its OWN line). Cut from the label to EOF — but ONLY when the
	// labelled remainder actually carries a citation marker or a URL (a real dump), so a prose "…covers
	// three sources: a, b and c" is never cut. This removes a HETEROGENEOUS block (URLs + titles under one
	// label) wholesale, before the per-form url/list/title guards run and one of them consumes the label.
	if (opts.grounded && !flagged) {
		// Scan EVERY standalone inline label and cut at the FIRST one that actually introduces a dump —
		// the FIRST token after its colon (past whitespace/bullets) is a "[n]" marker or URL. Checking the
		// evidence LOCALLY (not over the whole remainder) keeps a prose "References: see appendix." intact
		// even when a later normal sentence has a [1]; scanning ALL labels (not just the first) still
		// catches a real "Sources: https://…" dump that follows such a prose label.
		INLINE_SOURCE_LABEL.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = INLINE_SOURCE_LABEL.exec(working)) !== null) {
			const afterColon = working.slice(m.index + m[0].length);
			// (a) High-confidence: the FIRST token after the colon is a "[n]" marker or URL.
			const startsWithMarkerOrUrl = /^[\s\-–—•*|]*(?:\[\d+\]|https?:\/\/)/.test(afterColon);
			// (b) A fabricated inline bibliography with NO markers/URLs (e.g. `Sources: Meta AI Blog:
			// "LLaMA 2" (2025); Mistral AI Blog: "Open Models" (2025)`) — the whole-line heading guard
			// misses it and the title guard can't match its invented titles. Signal it LOCALLY (never by
			// scanning the whole remainder, which would re-trip on a later normal sentence): the remainder
			// starts like a title (uppercase/quote/digit, NOT lowercase prose like "see appendix") AND
			// splits into ≥2 entries on a bibliography separator (; | • or newline).
			const startsLikeEntry = /^\s*["“'0-9A-Z]/.test(afterColon);
			const isMultiEntry =
				afterColon.split(/[;|•]|\n/).filter((s) => s.trim().length > 0).length >= 2;
			if (startsWithMarkerOrUrl || (startsLikeEntry && isMultiEntry)) {
				const head = working.slice(0, m.index + m[1].length).trimEnd();
				if (head.length >= MIN_KEEP_CHARS) {
					working = head;
					flagged = true;
				}
				break;
			}
			if (m.index === INLINE_SOURCE_LABEL.lastIndex) INLINE_SOURCE_LABEL.lastIndex++;
		}
	}

	// 2. Fictional/illustrative-source disclaimer sentences (all turns).
	const sentences = splitSentences(working);
	const kept = sentences.filter((s) => !isDisclaimerSentence(s));
	if (kept.length !== sentences.length) {
		const deDisclaimed = kept
			.join(" ")
			.replace(/[ \t]{2,}/g, " ")
			.trim();
		if (deDisclaimed.length >= MIN_KEEP_CHARS) {
			working = deDisclaimed;
			flagged = true;
		}
	}

	if (!flagged) return { flagged: false, cleaned: original };
	const cleaned = working.replace(/\n{3,}/g, "\n\n").trim();
	if (cleaned.length < MIN_KEEP_CHARS) return { flagged: true, cleaned: original };
	return { flagged: true, cleaned };
}

// ── Heading-less trailing source list ───────────────────────────────────────────────────────────
// The sibling case detectFabricatedSources' heading-trim MISSES: a model reproduces the retrieved
// sources as a bare "[1] Title [2] Title [3] Title" block at the end of the answer with NO "Sources:"
// heading line. It slips every existing guard on a grounded turn — the [n] markers are in-range (so
// stripDanglingCitations keeps them), sourceCount>0 (so stripUnbackedSourceClaims stands down), and
// there is no heading (so the block above never fires). addInlineCitations then linkifies each [n]
// but leaves the titles as raw prose, so the list renders as one unreadable inline run concatenated
// onto the last paragraph (the grounding prompt forbids it verbatim, but a model can ignore it, as in
// hedgeGuard). The real sources already render in SourceStrip, so the body
// list is a duplicate. This strips it.
//
// CONSERVATIVE by construction: it only cuts a trailing run of "[n] <text>" entries whose text
// actually matches the RETRIEVED source of that number (entryMatchesTitle below), and only when the
// answer ENDS with such an entry. A genuine numbered enumeration ("options: [1] do X [2] do Y") never
// reproduces the retrieved titles, so it is never mistaken for a bibliography; an inline citation
// ("…adopted in 2024 [1].") ends in punctuation, not a title, so the tail never matches either.

export interface TrailingSourceListSource {
	/** citation number the model was told to use for this source (combined RAG[1..k] + web[k+1..]). */
	n: number;
	/** the retrieved source title, as shown in SourceStrip. */
	title: string;
}

// Any [n] marker. Reused to enumerate marker positions across the whole answer.
const CITATION_MARKER = /\[(\d+)\]/g;

// Normalize a title/entry for tolerant comparison: NFKC-fold (width/compatibility variants), casefold,
// then collapse EVERY non-alphanumeric run — straight AND typographic apostrophes/quotes, dashes, the
// `|`/`·` separators, whitespace — to a single space. Folding every quote to a space (rather than
// deleting only ASCII quotes, an earlier bug) keeps a curly-apostrophe source title ("Europe's") and a
// straight-quote model reproduction ("Europe's") in lockstep — both become "europe s" — so the
// duplicate still matches instead of leaking.
function normalizeForMatch(s: string): string {
	return s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// Does the text between two markers look like a reproduction of the retrieved title for that number?
// Equal, a prefix either way (the model truncates a long title, or appends a publisher/domain), or a
// near-total word overlap — but a candidate far LONGER in words than the title is rejected as prose
// (an inline citation whose host sentence merely happens to repeat the title's words).
function entryMatchesTitle(entryRaw: string, titleRaw: string): boolean {
	const entry = normalizeForMatch(entryRaw);
	const title = normalizeForMatch(titleRaw);
	if (!entry || !title) return false;
	if (entry === title) return true;
	if (entry.startsWith(title) || title.startsWith(entry)) {
		const shorter = Math.min(entry.length, title.length);
		const longer = Math.max(entry.length, title.length);
		return shorter / longer >= 0.5;
	}
	const entryWords = entry.split(" ");
	const titleWords = title.split(" ");
	if (entryWords.length > titleWords.length + 2) return false; // a prose span, not a title
	const entrySet = new Set(entryWords);
	let shared = 0;
	for (const w of titleWords) if (entrySet.has(w)) shared++;
	return shared / titleWords.length >= 0.8;
}

// A trailing STANDALONE "Sources:"-style label at the end of the head — at the start, on its own line,
// or right after a sentence boundary — that introduces an inline "Sources: [1] …" list the whole-line
// SOURCE_HEADING can't catch. The boundary prefix is REQUIRED so the last word of an ordinary sentence
// ("…point to two official references:") is NOT mistaken for a label; a colon is required too, so a
// prose tail ending in the bare word "sources" ("…drawn from several open sources") never matches.
// Group 1 is the label ALONE (no boundary prefix) — removing just the group preserves the sentence's
// punctuation (use withoutTrailingSourceLabel, or subtract group-1's length from a match index).
export const TRAILING_SOURCE_LABEL =
	/(?:^|\n|[.!?]["'’”)\]]*\s+)((?:\*\*|__|#{1,6}[ \t]*)*(?:sources?|references?|bibliography|works\s+cited|citations?)[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*)$/i;

/** Remove a trailing standalone source label from `head`, keeping the sentence boundary before it. */
export function withoutTrailingSourceLabel(head: string): string {
	return head.replace(TRAILING_SOURCE_LABEL, (m: string, label: string) =>
		m.slice(0, m.length - label.length)
	);
}

/**
 * Strip a heading-less trailing source list — a run of `[n] <title>` entries the model appended at the
 * end of the answer, each reproducing a RETRIEVED source's title. Grounded turns only (`opts.grounded`);
 * the real sources render separately (SourceStrip), so the body list is a duplicate. Never returns an
 * empty answer: when a safe strip isn't possible (fewer than two matched entries, or too little would
 * remain), `cleaned` is the original and `flagged` is false. Pure + side-effect-free for unit testing.
 */
export function stripTrailingSourceList(
	text: string,
	sources: TrailingSourceListSource[],
	opts: SourceGuardOptions = {}
): FabricatedSourceResult {
	const original = text ?? "";
	if (!opts.grounded || !sources.length || !original.includes("[")) {
		return { flagged: false, cleaned: original };
	}

	const titleByNum = new Map<number, string>();
	for (const s of sources) if (!titleByNum.has(s.n)) titleByNum.set(s.n, s.title);

	// Enumerate every [n] marker with its position.
	const markers: { num: number; start: number; end: number }[] = [];
	CITATION_MARKER.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CITATION_MARKER.exec(original)) !== null) {
		markers.push({ num: Number(m[1]), start: m.index, end: m.index + m[0].length });
	}
	if (markers.length < 2) return { flagged: false, cleaned: original };

	// Walk backward from the LAST marker: an entry qualifies when the text up to the next marker (or
	// EOF for the last one) reproduces its source's title. Stop at the first marker that doesn't — that
	// boundary is where the bibliography starts and the real answer ends. Requiring the answer to END on
	// a matched entry is what keeps ordinary inline citations (which end in punctuation) out.
	let firstListMarker = -1;
	for (let i = markers.length - 1; i >= 0; i--) {
		const entryEnd = i + 1 < markers.length ? markers[i + 1].start : original.length;
		const entryText = original.slice(markers[i].end, entryEnd);
		const title = titleByNum.get(markers[i].num);
		if (title && entryMatchesTitle(entryText, title)) {
			firstListMarker = i;
			continue;
		}
		break;
	}
	if (firstListMarker === -1 || markers.length - firstListMarker < 2) {
		return { flagged: false, cleaned: original };
	}

	// Only strip when the list is APPENDED to a finished answer: the text before the first list marker
	// must end on terminal punctuation (a completed sentence) or a "Sources:"-style label. This spares a
	// legitimate INLINE enumeration whose citations ARE the answer — "The two documents to read are [1]
	// Title and [2] Title" — where cutting would leave the broken fragment "…to read are"; the appended
	// bibliography ("…principles. [1] Title [2] Title") still has its terminal period and is cut.
	const preCut = original.slice(0, markers[firstListMarker].start);
	// terminal .!? then any closing quotes/brackets then trailing whitespace, at end of the head.
	const endsFinished = /[.!?][)"'’”“‘»\]]*\s*$/.test(preCut);
	if (!endsFinished && !TRAILING_SOURCE_LABEL.test(preCut)) {
		return { flagged: false, cleaned: original };
	}

	// Cut at the first list marker, then tidy the head: first drop a dangling inline "Sources:" label
	// the list was introduced by (keeping the sentence boundary), then trailing separators/whitespace.
	let head = withoutTrailingSourceLabel(original.slice(0, markers[firstListMarker].start));
	head = head.replace(/[\s–—•*|,:;-]+$/u, "");
	const cleaned = head.replace(/\n{3,}/g, "\n\n").trim();
	if (cleaned.length < MIN_KEEP_CHARS) return { flagged: false, cleaned: original };
	return { flagged: cleaned !== original, cleaned };
}

// ── Heading-less trailing TITLE dump (marker-optional) ──────────────────────────────────────────
// The form stripTrailingSourceList (which needs a "[n]" before EACH entry) MISSES: the model appends
// the retrieved source TITLES as one run with at most a single leading marker and NO per-entry markers
// —  "…technology. [1] FIFA World Cup 2026 – Wikipedia  IPCC Sixth Assessment Report – IPCC  GPT-4
// Release – OpenAI Blog …". Instead of keying on markers, this matches the retrieved TITLES
// themselves: it strips a trailing run of ≥2 reproduced titles separated only by short, prose-free gaps
// (a publisher, a "–"/"|" separator, a stray marker, whitespace) that reaches the end of the answer.
// Conservative: titles must be distinctive (≥2 significant words), the run must contain a list-style
// separator (so an ordinary "…the IPCC report and the NASA program." sentence is never a dump), it must
// sit after a finished sentence, and the safety floor still applies.

// A trailing run of a title match's own gap: publishers/separators/markers/whitespace, but no sentence.
const TITLE_DUMP_GAP_MAX = 64;
const LIST_SEPARATOR = /[–—|•]|\[\d+\]|\n/; // an en/em-dash, pipe, bullet, [n] marker, or newline

// Build a tolerant matcher for a title: its significant words (≥2 chars or containing a digit) joined
// by "any non-word run", so "NASA Artemis Program" matches "NASA Artemis Program" / "nasa-artemis
// program" alike. Alphanumeric look-around anchors the whole run to word boundaries so a short title
// ("AI Act", "New York") does NOT match the prefix of a longer word ("AI action", "New Yorkers").
// Returns null for a title too short/generic to match safely (fewer than 2 such words).
function titleMatcher(title: string): RegExp | null {
	const words = normalizeForMatch(title)
		.split(" ")
		.filter((w) => w.length >= 2 || /\d/.test(w));
	if (words.length < 2) return null;
	return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("[\\W_]+")})(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Strip a heading-less trailing TITLE dump — a run of ≥2 reproduced retrieved-source titles at the end
 * of a grounded answer, with or without per-entry "[n]" markers. Grounded turns only; the real sources
 * render separately (SourceStrip). Never empties the answer: `cleaned` is the original and `flagged`
 * false when a safe strip isn't possible. Pure + side-effect-free for unit testing.
 */
export function stripTrailingTitleDump(
	text: string,
	sources: TrailingSourceListSource[],
	opts: SourceGuardOptions = {}
): FabricatedSourceResult {
	const original = text ?? "";
	if (!opts.grounded || sources.length < 2) return { flagged: false, cleaned: original };

	// All match ranges of any distinctive retrieved title, merged so overlaps count once.
	const ranges: { start: number; end: number }[] = [];
	for (const s of sources) {
		const re = titleMatcher(s.title);
		if (!re) continue;
		let m: RegExpExecArray | null;
		while ((m = re.exec(original)) !== null) {
			ranges.push({ start: m.index, end: m.index + m[0].length });
			if (m.index === re.lastIndex) re.lastIndex++; // guard against a zero-width match stall
		}
	}
	if (ranges.length < 2) return { flagged: false, cleaned: original };
	ranges.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number }[] = [];
	for (const r of ranges) {
		const last = merged.at(-1);
		if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
		else merged.push({ ...r });
	}
	if (merged.length < 2) return { flagged: false, cleaned: original };

	// The last matched title must sit at the END of the answer (only a short publisher/separator tail
	// after it, no following sentence) — otherwise this is a title mentioned in prose, not a dump.
	const tail = original.slice(merged[merged.length - 1].end);
	if (tail.length > TITLE_DUMP_GAP_MAX || /[.!?]\s/.test(tail)) {
		return { flagged: false, cleaned: original };
	}
	// Walk backward while each consecutive pair of titles is separated by a short, prose-free gap that
	// carries a LIST separator (–/—/|/•/[n]/newline). A prose connector ("… and the …", "… which
	// covers … and …") has NO such separator directly between the two titles, so an ordinary sentence
	// that merely names two sources — even one containing an em dash elsewhere — ends the run here.
	let runStart = merged.length - 1;
	for (let i = merged.length - 1; i > 0; i--) {
		const gap = original.slice(merged[i - 1].end, merged[i].start);
		if (gap.length <= TITLE_DUMP_GAP_MAX && !/[.!?]\s/.test(gap) && LIST_SEPARATOR.test(gap)) {
			runStart = i - 1;
		} else break;
	}
	if (merged.length - runStart < 2) return { flagged: false, cleaned: original };

	// Absorb a single leading "[n]" marker; the run MUST be introduced by that marker or a "Sources:"
	// label. A markerless, label-less title run is indistinguishable from a legitimate answer that ends
	// by naming its sources (or a user-requested source comparison), so it is left untouched.
	let cut = merged[runStart].start;
	const lead = original.slice(0, cut).match(/\[\d+\]\s*$/);
	if (lead) cut -= lead[0].length;
	const preCut = original.slice(0, cut);
	const hasLabel = TRAILING_SOURCE_LABEL.test(preCut); // a STANDALONE "Sources:" introducer only
	if (!lead && !hasLabel) return { flagged: false, cleaned: original };
	// The introducer must sit after a finished sentence (or itself BE the standalone label).
	if (!hasLabel && !/[.!?][)"'’”“‘»\]]*\s*$/.test(preCut)) {
		return { flagged: false, cleaned: original };
	}
	const head = withoutTrailingSourceLabel(preCut).replace(/[\s–—•*|,:;-]+$/u, "");
	const cleaned = head.replace(/\n{3,}/g, "\n\n").trim();
	if (cleaned.length < MIN_KEEP_CHARS) return { flagged: false, cleaned: original };
	return { flagged: cleaned !== original, cleaned };
}
