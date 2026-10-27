// Dangling-citation guard — strips bracketed reference markers the answer can't back.
//
// On a GROUNDED turn the model is told to cite retrieved sources inline as [1], [2], … matching a
// combined list (RAG/community sources [1..k] then open-web sources [k+1..]; see ChatMessage.svelte
// citationSources and conversation/[id]/+server.ts — RAG startAt=0, web startAt=communityCount).
// A model can emit a marker with NO matching source — [2] when only [1] was retrieved, or a
// stray [0]. The renderer (addInlineCitations in utils/marked) safely declines to linkify it, but
// leaves the literal "[2]" sitting in the prose, which reads like a typo. This is the deterministic
// post-gen strip of those out-of-range markers, run in the same FinalAnswer seam as the recency-hedge
// and unverifiable-URL guards so the persisted, rendered, and exported text all agree.
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the eval harness.
//
// Conservative: only runs when there IS a source list (sourceCount > 0 — an ungrounded turn's "[2]"
// is ordinary text, not a citation), keeps every IN-RANGE marker untouched, and never rewrites inside
// a fenced code block, inline-code span, URL, or a markdown link/reference ([1](url) or [1]: url),
// where a bracketed number is not a citation.

export interface CitationGuardResult {
	/** at least one out-of-range marker was removed */
	stripped: boolean;
	/** the text with dangling [n] markers removed; the ORIGINAL when there was nothing to strip */
	cleaned: string;
}

// Spans we must not touch (a [n] inside is not a citation): code, URLs. A fence the stream never
// closed (the model hit its length cap mid-block) runs to the end of the text (CUR-3874).
const PROTECTED_SPAN = /```[\s\S]*?(?:```|$(?![\s\S]))|`[^`]*`|https?:\/\/\S+/g;
// A citation marker = optional single leading space + [digits], NOT immediately followed by "(" or
// ":" (that would be a markdown link or reference definition, not an inline citation).
const MARKER = / ?\[(\d+)\](?![(:])/g;
const SENTINEL = String.fromCharCode(0xe000);
const RESTORE = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");

/** Stash code and URL spans behind sentinels, so a [n] inside one is never read as a citation. */
function maskProtected(text: string): { masks: string[]; masked: string } {
	const masks: string[] = [];
	const masked = text.replace(PROTECTED_SPAN, (m) => {
		masks.push(m);
		return SENTINEL + (masks.length - 1) + SENTINEL;
	});
	return { masks, masked };
}

/**
 * Remove inline citation markers that point past the retrieved source list (index 0 or > sourceCount).
 * `sourceCount` is the combined web+RAG source count the model was given. Returns the original text and
 * `stripped:false` when there is nothing to remove (incl. an ungrounded turn where sourceCount <= 0).
 */
export function stripDanglingCitations(text: string, sourceCount: number): CitationGuardResult {
	const original = text ?? "";
	// Not a citation context (ungrounded) or nothing bracketed → leave ordinary "[2]" text alone.
	if (sourceCount <= 0 || !original.includes("[")) return { stripped: false, cleaned: original };

	const { masks, masked } = maskProtected(original);
	const rewritten = masked.replace(MARKER, (whole, n) => {
		const idx = Number(n);
		return idx >= 1 && idx <= sourceCount ? whole : "";
	});
	const cleaned = rewritten.replace(RESTORE, (_, i) => masks[Number(i)]);
	return { stripped: cleaned !== original, cleaned };
}

// Citation-intent signal: the answer POSES as sourced (so a bare "[1]" is a fabricated citation,
// not an ordinary list marker). Conservative gate so plain lists ("[1] step one") are left alone.
const CITATION_INTENT = /\b(?:sources?|references?|citations?|cited|bibliography)\b/i;
const SEE_MARKER = /\b(?:see|check|refer to|consult|listed in|found in)\b[^.!?\n]{0,40}\[\d+\]/i;

/**
 * Strip INLINE citation markers — a `[n]` that trails text on the same line — from a no-source answer,
 * via an explicit left-to-right scan (no regex): for each `[digits]` token we look at what precedes it
 * and decide keep-or-drop in the open, not inside a pattern. The cases:
 *   • inline ("…Shakespeare. [1]" / "x[2]")  → DROP (a fabricated citation on a no-source turn)
 *   • line-start ("\n[1] open the file")      → KEEP (a plain numbered-list marker)
 *   • markdown link/ref ("[1](url)" / "[1]:") → KEEP (handled by the next-char check)
 * Code/URL `[n]` is already masked out by the caller, so it never reaches here. Pure + testable.
 */
export function stripInlineCitations(text: string, visitorCount = 0): CitationGuardResult {
	const s = text ?? "";
	let out = "";
	let removed = false;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "[") {
			let j = i + 1;
			while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
			const isMarker = j > i + 1 && s[j] === "]"; // [<digits>]
			const next = s[j + 1];
			const isLinkOrRef = next === "(" || next === ":"; // [n](url) / [n]: ref — not a citation
			// The visitor's own pasted sources are backed by their message (visitorSources.ts, CUR-3844).
			const markerN = Number(s.slice(i + 1, j));
			const isVisitors = isMarker && markerN >= 1 && markerN <= visitorCount;
			if (isMarker && !isLinkOrRef && !isVisitors) {
				// Look back past a single optional space to the previous visible char. Start-of-string or a
				// newline ⇒ this is a line-start list marker (keep); anything else ⇒ inline citation (drop).
				let k = i - 1;
				if (k >= 0 && (s[k] === " " || s[k] === "\t")) k--;
				const lineStart = k < 0 || s[k] === "\n";
				if (!lineStart) {
					// Drop the emphasis wrapped around the marker with it, so "Source **[1]**." leaves no
					// empty "****" in the prose (CUR-3844).
					let after = j + 1;
					const wrap = ["**", "__", "*", "_"].find((w) => out.endsWith(w) && s.startsWith(w, after));
					if (wrap) {
						out = out.slice(0, -wrap.length);
						after += wrap.length;
					}
					// drop the marker AND the single space we already emitted before it
					if (out.endsWith(" ") || out.endsWith("\t")) out = out.slice(0, -1);
					i = after;
					removed = true;
					continue;
				}
			}
		}
		out += s[i];
		i++;
	}
	return { stripped: removed, cleaned: out };
}
// A whole sentence that promises sources via bracket markers ("For detailed sources, check [1] or [2].").
const SOURCE_PROMISE_SENTENCE =
	/[^.!?\n]*\b(?:sources?|references?|citations?|details?)\b[^.!?\n]*\[\d+\][^.!?\n]*[.!?]?/gi;

/**
 * The UNGROUNDED sibling of {@link stripDanglingCitations}. On a turn with NO retrieved sources
 * (`sourceCount <= 0`), a citation apparatus is fabricated by construction — there is nothing to
 * cite. This removes it: whole "for sources, see [n]" promise sentences first, then any leftover
 * INLINE `[n]` citation (a marker trailing prose). Fires when the answer poses as sourced — source
 * language, a "see [n]" phrase, a promise sentence, OR a bare inline citation like "…Shakespeare. [1]"
 * (fabricated on a no-source turn) — but a plain line-start list marker `[1]` is left untouched. Same
 * code/URL/link protection as the dangling-citation guard, and conservative — never guts the answer.
 *
 * This is the no-evidence case of the general invariant the honesty guards share: a claim of
 * external backing must resolve to real retrieved evidence; with an empty evidence set, none is allowed.
 */
export function stripUnbackedSourceClaims(
	text: string,
	sourceCount: number,
	visitorCount = 0
): CitationGuardResult {
	const original = text ?? "";
	// Real sources exist → the grounded guards (stripDanglingCitations / verifyCitationLabels) own it.
	if (sourceCount > 0 || !original.includes("[")) return { stripped: false, cleaned: original };
	// Mask code/URL spans first so a [n] inside them is never considered or stripped.
	const { masks, masked } = maskProtected(original);
	// Remove fabricated "for sources, see [n]" promise sentences, then strip leftover INLINE [n] citations
	// (the scan keeps line-start list markers).
	// A sentence pointing only at the visitor's own numbered sources keeps its promise (CUR-3844).
	const afterPromise = masked.replace(SOURCE_PROMISE_SENTENCE, (sentence) =>
		[...sentence.matchAll(/\[(\d+)\]/g)].every((m) => Number(m[1]) >= 1 && Number(m[1]) <= visitorCount)
			? sentence
			: ""
	);
	const inline = stripInlineCitations(afterPromise, visitorCount);
	// Fire only when the answer actually poses as sourced: explicit source language, a "see [n]" phrase,
	// a promise sentence we removed, OR a bare inline citation trailing prose ("…Shakespeare. [1]"). A
	// plain numbered list (line-start markers only) trips none of these → left untouched.
	if (
		!CITATION_INTENT.test(masked) &&
		!SEE_MARKER.test(masked) &&
		afterPromise === masked &&
		!inline.stripped
	) {
		return { stripped: false, cleaned: original };
	}
	// Source wording with nothing to remove leaves the answer exactly as written (CUR-3874).
	if (afterPromise === masked && !inline.stripped) return { stripped: false, cleaned: original };
	// Tidy connectors/whitespace a partial strip can leave behind ("check  or ."), while code and URLs
	// are still masked, so a code block's indentation is never collapsed (CUR-3874).
	const tidied = inline.cleaned
		.replace(/\b(?:check|see|refer to|consult)\s+(?:or|and|,)?\s*(?=[.!?\n]|$)/gi, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([.!?,;])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const cleaned = tidied.replace(RESTORE, (_, i) => masks[Number(i)]);
	// Conservative: never gut the answer on an over-broad match.
	if (!cleaned || cleaned.length < original.length * 0.4) {
		return { stripped: false, cleaned: original };
	}
	return { stripped: cleaned !== original, cleaned };
}
