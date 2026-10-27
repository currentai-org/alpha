// Citation-LABEL faithfulness guard — strips confabulated source labels the retrieved data contradicts.
//
// The failure: on a grounded turn a model can write a "source roll-call" in
// prose — "check recent reports from [1] (European Commission), [2] (White House), [3] (OpenAI blog)…" —
// where the parenthetical NAMES are guessed and don't match the pages actually retrieved as sources 1,2,3.
// The [n] marker links correctly to the real source (renderer/SourceStrip are honest), but the model's
// label lies, so [1] reads as "European Commission" yet navigates somewhere else → "wrong website". The
// grounding prompt already forbids a bibliography, but a prompt alone cannot guarantee it, so (like every
// other guard here) the fix is a deterministic, post-hoc, out-of-prompt pass.
//
// Framing: correctness ≠ faithfulness — a citation must be supported by the source it points to,
// and you cannot get that from the model's own prose; you VERIFY attribution against the retrieved data
// (post-hoc attribution / metadata-consistency), never trust a self-assigned label. This is the cheap,
// deterministic, zero-network layer of that recipe (a sibling to citationGuard's existence/range check and
// urlGuard's URL-validity check); NLI claim-entailment is the heavier, documented-brittle Tier 2 we leave
// flag-gated. Refs: Wallat et al. 2025 (correctness≠faithfulness); generation-time vs post-hoc (2509.21557).
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the eval harness.
//
// Conservative by construction (bias AGAINST clipping legitimate prose):
//   • only a SPACE-separated parenthetical after an in-range marker — `[n] (Label)`, never `[n](url)`;
//   • only when the label looks like a NAME (has a Capitalised word) — leaves "(2024)", "(see below)";
//   • only when the label carries identifying tokens AND none of them match the real source's title/host
//     (fuzzy: exact / substring / ≥4-char shared prefix, so "European"~"europa", "White"~"whitehouse");
//   • keeps the [n] marker itself (it links to the real source) — strips ONLY the lying parenthetical;
//   • a source with no title/url can't be verified → left untouched.

export interface CitationLabelSource {
	title?: string;
	url?: string | null;
}

export interface CitationLabelResult {
	/** at least one unfaithful label was stripped */
	flagged: boolean;
	/** the text with contradicted labels removed; the ORIGINAL when nothing changed */
	cleaned: string;
	/** how many labels were stripped */
	count: number;
}

// Publisher-type / filler / TLD words that don't IDENTIFY a specific source (so they can't, on their own,
// make a label count as "faithful" — otherwise "(OpenAI blog)" would match any source whose title has "blog").
const GENERIC = new Set([
	"blog",
	"news",
	"report",
	"reports",
	"website",
	"site",
	"page",
	"article",
	"press",
	"release",
	"com",
	"org",
	"net",
	"gov",
	"edu",
	"www",
	"the",
	"official",
	"online",
	"source",
	"sources",
	"via",
	"from",
	"update",
	"updates",
	"home",
	"index",
	"html",
]);

function tokens(s: string): string[] {
	return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
		(t) => t.length >= 3 && !GENERIC.has(t)
	);
}

function hostTokens(url?: string | null): string[] {
	if (!url) return [];
	try {
		const host = new URL(url).hostname.replace(/^www\./, "");
		return tokens(host.replace(/\./g, " "));
	} catch {
		return [];
	}
}

// Fuzzy identity-token match: exact, substring (≥4), or ≥4-char shared prefix. Handles real-world
// publisher↔domain skew: "european"~"europa" (prefix), "white"⊂"whitehouse" (substring).
function tokenMatch(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length >= 4 && b.includes(a)) return true;
	if (b.length >= 4 && a.includes(b)) return true;
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i >= 4;
}

function labelIsFaithful(label: string, source: CitationLabelSource): boolean {
	const idTokens = [...tokens(source.title ?? ""), ...hostTokens(source.url)];
	if (!idTokens.length) return true; // nothing to verify against → don't strip (conservative)
	const labelTokens = tokens(label);
	if (!labelTokens.length) return true; // no identifying tokens in the label → leave it
	return labelTokens.some((lt) => idTokens.some((it) => tokenMatch(lt, it)));
}

// `[n] (Label)` — a marker, a SPACE, then a non-nested parenthetical up to ~60 chars. The space is what
// distinguishes a source label from a markdown link `[n](url)`. `sources` is the combined, ordered list
// the model was given (RAG/community [1..k] then open web [k+1..]); array index = citation number − 1.
const CITED_LABEL = /\[(\d+)\] \(([^()]{1,60})\)/g;

export function verifyCitationLabels(
	text: string,
	sources: CitationLabelSource[],
	/** How many of the visitor's own numbered sources come first; `sources` starts after them (CUR-3844). */
	visitorCount = 0
): CitationLabelResult {
	const original = text ?? "";
	if (!sources.length || !original.includes("[")) {
		return { flagged: false, cleaned: original, count: 0 };
	}
	let count = 0;
	const cleaned = original.replace(CITED_LABEL, (whole, n: string, label: string) => {
		const src = sources[Number(n) - visitorCount - 1];
		if (!src) return whole; // out of range — citationGuard strips the marker itself
		if (!/[A-Z][A-Za-z]/.test(label)) return whole; // not a name ("(2024)", "(see below)") → keep
		if (labelIsFaithful(label, src)) return whole;
		count++;
		return `[${n}]`; // strip the contradicted label, keep the (correctly-linking) marker
	});
	return { flagged: count > 0, cleaned, count };
}
