// "open source" de-hyphenation guard — the runtime rewrite half of the open-source-style fix.
//
// House style, per the OSI: "open source" is NEVER hyphenated, even as a compound adjective
// ("an open source tool"), not just predicatively (https://opensource.org/blog/is-open-source-ever-hyphenated).
// Our own persona instructs the model to write "open-source", and models follow it, so
// answers can carry the wrong form. Like nameGuard/hedgeGuard, the reliable enforcement is a
// deterministic runtime test+correct OUT of the prompt — a prompt counter-instruction washes out
// This module is that correction, applied to the final answer text.
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the eval harness.
//
// Conservative: it NEVER rewrites inside a fenced code block, an inline-code span, or a URL — a
// hyphen there can be load-bearing (a path segment, package id, or CLI flag like
// github.com/foo/open-source or --open-source). Only the hyphen between open|source becomes a
// space, so case is preserved automatically (Open-Source -> Open Source, OPEN-SOURCE -> OPEN SOURCE).

export interface OpenSourceGuardResult {
	/** the answer contained a hyphenated "open-source" (outside code/URLs) that we rewrote */
	rewritten: boolean;
	/** the text with "open-source" -> "open source"; the ORIGINAL when there was nothing to change */
	cleaned: string;
}

// Spans we must not touch: fenced code, inline code, bare URLs. Masked out, rewritten around, restored.
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g;
// The hyphenated token and its common suffixes (source/sourced/sources/sourcing). Word-bounded so it
// never touches "closed-source" or a longer compound that merely contains the letters.
const HYPHENATED = /\b(open)-(sourc(?:e|ed|es|ing))\b/gi;
// Index sentinel for masked spans. A Private-Use-Area code point can't occur in model prose and
// HYPHENATED can't match it, so masking is collision-free (a literal " 0 " is never mistaken).
const SENTINEL = String.fromCharCode(0xe000);
const RESTORE = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");

/**
 * Rewrite the model's hyphenated "open-source" to "open source" in a final answer, leaving code
 * spans and URLs untouched. Returns `rewritten:false` + the original when there is nothing to fix.
 */
export function dehyphenateOpenSource(text: string): OpenSourceGuardResult {
	const original = text ?? "";
	// Fast path: no hyphen at all → nothing to do (also dodges the regex on the common case).
	if (!original.includes("-")) return { rewritten: false, cleaned: original };

	const masks: string[] = [];
	const masked = original.replace(PROTECTED_SPAN, (m) => {
		masks.push(m);
		return SENTINEL + (masks.length - 1) + SENTINEL;
	});
	const rewritten = masked.replace(HYPHENATED, "$1 $2");
	const cleaned = rewritten.replace(RESTORE, (_, i) => masks[Number(i)]);
	return { rewritten: cleaned !== original, cleaned };
}
