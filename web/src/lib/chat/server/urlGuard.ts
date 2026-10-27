// URL-fabrication guard — the runtime "de-link" half of the citation-honesty enforcement, sibling to
// $lib/chat/server/hedgeGuard and $lib/chat/server/nameGuard.
//
import { UNVERIFIED_TITLE } from "$lib/chat/constants/unverifiedHref";
import { TRAILING_SOURCE_LABEL } from "$lib/chat/server/sourceGuard";
export { UNVERIFIED_TITLE };
//
// Apertus can emit citation URLs it has no source for on UNGROUNDED turns: an "open-weights vs
// open source" answer can contain a fabricated `https://github.com/swissai/Apertus`, and a "tell me about
// Apertus" answer can link a repo that does not exist. Presenting an invented link as a citation directly
// erodes the chat's honesty value.
//
// Why a deterministic post-hoc guard and not the model fixing itself: the 2026 literature on citation/URL
// hallucination (CiteCheck arXiv:2605.27700; "Detecting & Correcting Reference Hallucinations"
// arXiv:2604.03173, which ships the MIT `urlhealth` tool) converges on two findings — (1) separate
// retrieval from verification, never let the model self-judge a citation, and (2) the strong agentic
// self-correction result only holds for a COMPETENT tool-user; a weak one "called the verification tool
// but failed to act on its results" across many rounds. Apertus does not reliably act on tool results (the search trigger
// is a logprob margin gate because it does not reliably tool-call), so an agentic loop would fail.
// Hence a deterministic, server-side, zero-network check that WE apply — the same shape as hedgeGuard.
//
// Scope: this only de-links URLs that we can't vouch for. The grounded-turn grounding prompt already tells
// the model to cite [1][2] inline and not append raw URLs, and the real source URLs are rendered
// separately by the UI, so fabricated URLs are overwhelmingly an ungrounded-turn phenomenon. We keep:
//   - URLs on our small static allow-list of domains we legitimately link, and
//   - on a grounded turn, URLs whose host matches a retrieved source.
// Everything else is FLAGGED: it stays a normal CLICKABLE link (real href kept) but carries the
// UNVERIFIED_TITLE sentinel as its markdown title, which the renderer turns into a dotted-underline link
// with a small "?" superscript (and the message carries a urlNotice the trace surfaces). We do NOT
// de-link: a deterministic guard can't tell a real URL from a fabricated one, so killing the href is wrong
// half the time — it destroys real, working links AND hides them. Keeping the link clickable is honest both
// ways (a real link works; a fabricated one openly 404s) while staying visibly marked as unverified. A
// live-liveness tier (porting urlhealth's HEAD→GET + Wayback check to TS) is a deliberate phase-2 follow-on.
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the eval harness.

export interface UrlGuardResult {
	/** the guard modified the text — a URL was rewritten to its canonical link, stripped, or flagged
	 *  unverified. It's the caller's gate to apply `cleaned`. */
	flagged: boolean;
	/** text with unverified URLs kept CLICKABLE (real href intact) but tagged with the UNVERIFIED_TITLE
	 *  sentinel as their markdown title, which the renderer turns into a dotted-underline link + "?" marker.
	 *  Only link syntax is rewritten (title added / bare URL wrapped), never the prose, so this can never
	 *  empty or gut the answer — no fallback needed. */
	cleaned: string;
	/** the unverified URLs that were flagged (for the message's urlNotice / eval) */
	urls: string[];
}

// Domains we legitimately link and trust even on an ungrounded turn. Host-suffix match (so subdomains
// like en.wikipedia.org are covered). Deliberately does NOT include github.com — we don't currently cite
// a verified GitHub repo in answers, and that is exactly the host the model fabricated. Add an entry
// (optionally host+path-scoped, e.g. "github.com/swiss-ai") only once a link there is real and intended.
const STATIC_ALLOW = [
	"aipotluck.org",
	"huggingface.co",
	"wikipedia.org",
	"wikimedia.org",
	"openalex.org",
	"swiss-ai.org",
	// The country-by-country crisis line finder the persona and crisisReferralOrder.ts send people to
	// (CUR-2136). Unlisted, every distress answer's helpline link carried the "unverified" mark.
	"findahelpline.com",
];

// Self-referential / partner entities the model fabricates links for (github.com/snai/apertus-70b,
// snai.ai/model-cards/Apertus-70B, …). Shipping the fabrication is a clickable 404 to a partner's page,
// so we resolve it instead: an entity we HAVE a real link for is
// REWRITTEN to that canonical link (clickable + correct); a self-entity we have no canonical link for yet
// is STRIPPED (URL dropped, prose kept). Matched only against UNALLOWED urls, so a real huggingface.co
// Apertus link (allow-listed) is never touched. Ordered most-specific first: an Apertus URL also names
// SNAI, so Apertus must win. The canonical URLs are the ones verified from the live model-card citation,
// not invented. Broadening this to a general link-verification tier (ground-or-archive-or-resolve) is the
// phase-2 follow-on; this is the bounded, self-referential slice that has to be right.
const CANONICAL_LINKS: { entity: RegExp; url: string }[] = [
	{ entity: /apertus/i, url: "https://huggingface.co/swiss-ai/Apertus-70B-Instruct-2509" },
	{ entity: /\bsnai\b|\bswiss[-\s]?ai\b/i, url: "https://huggingface.co/swiss-ai" },
];
// Our own project, for which no canonical contribute/repo link exists yet — a fabricated one is stripped,
// not rewritten. aipotluck.org itself is on STATIC_ALLOW, so only OFF-domain fabrications reach here.
const STRIP_SELF = /\baipotluck\b|\bai[-\s]?potluck\b/i;

/** For an UNALLOWED url (+ its visible label), decide how to resolve a self-referential/partner
 *  fabrication: rewrite to a canonical real link, strip it, or (null) fall through to the "?" flag. */
function resolveSelfReferential(url: string, label: string): { canonical: string } | "strip" | null {
	const hay = `${url} ${label}`;
	for (const { entity, url: canonical } of CANONICAL_LINKS) {
		if (entity.test(hay)) return { canonical };
	}
	if (STRIP_SELF.test(hay)) return "strip";
	return null;
}

// Flagged URLs keep their real, clickable href and carry UNVERIFIED_TITLE (imported above) as the
// markdown link title. The renderer's `link` override ($lib/chat/utils/marked) recognises that title and renders
// a normal clickable link styled dotted with a small "?" superscript + tooltip — and the message carries a
// urlNotice the provenance trace surfaces. Encoding the flag in the title (not mangling the prose with an
// inline "(unverified)" string) keeps copy/export honest and the rendered answer clean.

/** Strip the scheme (and a leading www.) so a flagged bare URL's LABEL reads as plain text (the href still
 *  keeps the full URL). e.g. https://github.com/swissai/Apertus → github.com/swissai/Apertus */
function delinkLabel(url: string): string {
	return url.replace(/^https?:\/\/(www\.)?/i, "");
}

function hostMatches(host: string, suffix: string): boolean {
	return host === suffix || host.endsWith("." + suffix);
}

function isAllowed(rawUrl: string, groundedHosts: Set<string>): boolean {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return false; // unparseable → treat as not-allowed (it'll be de-linked)
	}
	const host = u.hostname.toLowerCase();
	for (const entry of STATIC_ALLOW) {
		if (entry.includes("/")) {
			const slash = entry.indexOf("/");
			const eh = entry.slice(0, slash);
			const ep = entry.slice(slash);
			if (hostMatches(host, eh) && u.pathname.startsWith(ep)) return true;
		} else if (hostMatches(host, entry)) {
			return true;
		}
	}
	return groundedHosts.has(host);
}

// Markdown inline link: [text](http(s)://…). Capture the visible text and the URL separately.
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
// Bare/autolinked URL, NOT the URL inside a markdown link (those are preceded by "](").
const BARE_URL = /(?<!\]\()https?:\/\/[^\s)<>\]]+/g;

export interface UrlGuardOptions {
	/** the turn was grounded on a fresh web search / RAG evidence */
	grounded?: boolean;
	/** retrieved source URLs (web search + RAG) — their hosts are trusted on a grounded turn */
	allowedUrls?: string[];
}

/**
 * Flag any URL in `text` that we can't vouch for by tagging it with the UNVERIFIED_TITLE sentinel as its
 * markdown title (the renderer keeps it a clickable link but styles it dotted + "?"-marked). The caller
 * passes whether the turn was grounded and the retrieved source URLs; everything not on the static
 * allow-list or (when grounded) sharing a host with a retrieved source is flagged. Flagging only rewrites
 * link syntax (adds a title / wraps a bare URL), so it never empties or guts the answer. `urls` lists the
 * flagged URLs for the message's urlNotice.
 */
export function detectFabricatedUrls(text: string, opts: UrlGuardOptions = {}): UrlGuardResult {
	const original = text ?? "";
	if (!original.includes("http")) return { flagged: false, cleaned: original, urls: [] };

	const groundedHosts = new Set<string>();
	if (opts.grounded) {
		for (const raw of opts.allowedUrls ?? []) {
			try {
				groundedHosts.add(new URL(raw).hostname.toLowerCase());
			} catch {
				/* skip unparseable source URL */
			}
		}
	}

	const flaggedUrls: string[] = [];
	let changed = false;

	// Pass 1: markdown links. For an UNALLOWED url, first try to resolve it as a self-referential/partner
	// fabrication (rewrite to canonical / strip); otherwise KEEP the real href clickable + add the sentinel
	// title. Strip any scheme(s) from a flagged label so pass 2 can't re-match a URL the model put in the
	// label too (e.g. `[https://x](https://x)`) — that would double-flag into a nested marker (two "?"s).
	let out = original.replace(MD_LINK, (match, label: string, url: string) => {
		if (isAllowed(url, groundedHosts)) return match;
		const resolved = resolveSelfReferential(url, label);
		if (resolved === "strip") {
			changed = true;
			// drop the fabricated link, keep its human label as plain prose.
			return label.replace(/https?:\/\/(www\.)?/gi, "");
		}
		if (resolved) {
			changed = true;
			// rewrite to the canonical real link — a normal clickable link, NO unverified marker. If the
			// label was itself the (fabricated) URL, show the canonical URL as the label instead.
			const label2 = /^\s*https?:\/\//i.test(label) ? delinkLabel(resolved.canonical) : label;
			return `[${label2}](${resolved.canonical})`;
		}
		changed = true;
		flaggedUrls.push(url);
		return `[${label.replace(/https?:\/\/(www\.)?/gi, "")}](${url} "${UNVERIFIED_TITLE}")`;
	});

	// Pass 2: bare URLs (the lookbehind skips URLs still inside an allowed markdown link). Same resolve
	// order: canonical rewrite / strip a self-referential fabrication, else wrap as a CLICKABLE link tagged
	// with the sentinel title so it renders dotted + "?"-marked but still navigates.
	out = out.replace(BARE_URL, (url: string) => {
		if (isAllowed(url, groundedHosts)) return url;
		// Don't absorb trailing sentence punctuation into the link — split it back out so the period/comma
		// stays as prose ("…fairlearn." not a dotted "fairlearn." inside the link).
		const trail = (url.match(/[.,;:!?]+$/) ?? [""])[0];
		const core = trail ? url.slice(0, -trail.length) : url;
		const resolved = resolveSelfReferential(core, "");
		if (resolved === "strip") {
			changed = true;
			return trail; // drop the fabricated URL, keep any trailing punctuation so the prose still reads
		}
		if (resolved) {
			changed = true;
			return `[${delinkLabel(resolved.canonical)}](${resolved.canonical})${trail}`;
		}
		changed = true;
		flaggedUrls.push(core);
		return `[${delinkLabel(core)}](${core} "${UNVERIFIED_TITLE}")${trail}`;
	});

	if (!changed) return { flagged: false, cleaned: original, urls: [] };

	// Only link syntax is ever rewritten/stripped (never prose), so the answer is never gutted. `flagged`
	// = the guard touched a URL (rewrote, stripped, or marked it) — the caller's gate to apply `cleaned`.
	// `urls` lists ONLY the unverified (sentinel-marked) URLs for the urlNotice; canonical/stripped links
	// are resolved, not unverified, so they're deliberately not in it.
	// The caller passes one streaming batch at a time, and a batch often ends on the "\n" that separates
	// two list items. Trimming only what the rewrite left inside and putting the batch's own edges back
	// keeps that line break; trimming it fused the next item onto this line (CUR-2567).
	const lead = /^\s*/.exec(original)?.[0] ?? "";
	const tail = /\s*$/.exec(original)?.[0] ?? "";
	return { flagged: true, cleaned: lead + out.trim() + tail, urls: flaggedUrls };
}

// The sentinel-marked links that SURVIVE in a final answer body — `[label](url "<UNVERIFIED_TITLE>")`,
// the exact shape detectFabricatedUrls writes above. Lives next to the writer so reader and writer can't
// drift. Used to reconcile the urlNotice count to markers that actually render: urlCount is tallied
// per-streaming-batch as links are flagged, but a later end-of-stream source-strip (e.g. a fabricated URL
// inside a trailing "Sources:" block) can remove a flagged link AFTER it was counted — leaving the footer
// pointing at a "?" no longer in the answer. Recounting from the final text closes that orphan. Returns the
// flagged URLs in order, one per surviving mark (so both count and urls stay in sync with the body).
const MARKED_LINK = new RegExp(
	`\\]\\(([^\\s)]+)\\s+"${UNVERIFIED_TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`,
	"g"
);
export function markedUrlsIn(text: string): string[] {
	const out: string[] = [];
	MARKED_LINK.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MARKED_LINK.exec(text ?? "")) !== null) out.push(m[1]);
	return out;
}

// ── Raw source-URL dump ─────────────────────────────────────────────────────────────────────────
// The OTHER shape of the "reproduce the source list in the body" bug (sibling to sourceGuard's
// stripTrailingSourceList, which handles the "[n] Title" form). Here the model dumps the retrieved
// source URLs as bare autolinks — "https://espn… [1] https://reddit… [3] https://youtube… [4]" — the
// grounding prompt forbids it verbatim ("do NOT append … raw URLs at the end"), it duplicates the
// SourceStrip, and it renders as a wall of giant underlined links. detectFabricatedUrls
// above CAN'T catch it: it deliberately KEEPS a source URL clickable (its host matches a retrieved
// source), the honest thing for a single inline link but wrong for a dump. This removes such a dump —
// but only a RUN of ≥2 bare source URLs whose only interleaving is whitespace, list separators, and
// [n] markers, so a lone inline source link (or a numbered list that merely contains [n] markers) is
// never touched. Markdown angle autolinks (<https://…>) are handled too — same rendered wall of links.
// Never guts the answer. Pure + side-effect-free for unit testing.

// The gap allowed BETWEEN two URLs of one dump (and the trailing bit absorbed after the last): only
// whitespace, list bullets/dashes, and [n] citation markers — a prose word here ends the run.
const URL_LIST_GAP = /^[\s\-–—•*|,;:]*(?:\[\d+\][\s\-–—•*|,;:]*)*$/;
// Don't return a gutted answer — if a strip leaves less than this, keep the original.
const RAW_URL_MIN_KEEP = 24;

export interface RawSourceUrlSource {
	/** citation number the model was told to use for this source. */
	n: number;
	/** the retrieved source URL (used for host-matching AND leading-marker attribution). */
	url?: string;
}

export interface RawSourceUrlResult {
	/** a run of ≥2 bare source URLs was removed from the body */
	flagged: boolean;
	/** text with the dump(s) removed — or the ORIGINAL when a safe strip isn't possible. Never empty. */
	cleaned: string;
	/** the source URLs that were removed (for the message's notice / eval) */
	removed: string[];
}

/**
 * Strip a raw source-URL dump — a run of ≥2 bare autolinked URLs whose hosts match retrieved sources —
 * from a grounded answer's body. The real sources render separately (SourceStrip), so the body dump is
 * a duplicate the grounding prompt forbids. Only whitespace / list separators / [n] markers may sit
 * between the URLs of one run; a lone inline source link is left alone. `sources` supplies both the
 * trusted hosts and the citation-number→URL map used to absorb a marker-BEFORE-URL citation into the
 * cut (so "[1] https://a [2] https://b" leaves no orphan "[1]"), while a marker that cites the PRECEDING
 * sentence ("…decisions. [8] https://firstsource…") is left intact. Never empties the answer: when a
 * safe strip isn't possible, `cleaned` is the original and `flagged` is false. Pure + testable.
 */
export function stripRawSourceUrls(
	text: string,
	sources: RawSourceUrlSource[] = [],
	opts: { grounded?: boolean } = {}
): RawSourceUrlResult {
	const original = text ?? "";
	if (!opts.grounded || !original.includes("http")) {
		return { flagged: false, cleaned: original, removed: [] };
	}
	// Trusted hosts + the citation-number→host map, both derived from the retrieved sources.
	const groundedHosts = new Set<string>();
	const hostByNum = new Map<number, string>();
	for (const s of sources) {
		if (!s.url) continue;
		try {
			const host = new URL(s.url).hostname.toLowerCase();
			groundedHosts.add(host);
			if (!hostByNum.has(s.n)) hostByNum.set(s.n, host);
		} catch {
			/* skip unparseable source URL */
		}
	}
	if (groundedHosts.size === 0) return { flagged: false, cleaned: original, removed: [] };

	// Every bare URL whose host matches a retrieved source, with positions. A trailing sentence
	// punctuation run is split back out (stays as prose), and an enclosing Markdown angle autolink
	// (<https://…>) has its brackets absorbed into the hit so the cut removes them too.
	const hits: { host: string; core: string; start: number; end: number }[] = [];
	BARE_URL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = BARE_URL.exec(original)) !== null) {
		const trail = (m[0].match(/[.,;:!?]+$/) ?? [""])[0];
		const core = trail ? m[0].slice(0, -trail.length) : m[0];
		let host = "";
		try {
			host = new URL(core).hostname.toLowerCase();
		} catch {
			/* unparseable → not a source hit */
		}
		if (!host || !groundedHosts.has(host)) continue;
		let start = m.index;
		let end = m.index + core.length;
		if (original[start - 1] === "<" && original[end] === ">") {
			start -= 1;
			end += 1;
		}
		hits.push({ host, core, start, end });
	}
	if (hits.length < 2) return { flagged: false, cleaned: original, removed: [] };

	// Chain consecutive hits into runs separated only by URL_LIST_GAP; each run of ≥2 is a dump to cut.
	const removed: string[] = [];
	const cuts: { start: number; end: number }[] = [];
	let runStart = 0;
	for (let i = 1; i <= hits.length; i++) {
		const contiguous =
			i < hits.length && URL_LIST_GAP.test(original.slice(hits[i - 1].end, hits[i].start));
		if (contiguous) continue;
		if (i - 1 > runStart) {
			let start = hits[runStart].start;
			let end = hits[i - 1].end;
			// Absorb a trailing "[n]" marker after the LAST URL, when it cites that URL's host — same line,
			// or on its OWN line (a single newline), but NOT across a blank-line paragraph break (that
			// marker belongs to the next paragraph, not this dump).
			const tail = original.slice(end).match(/^[ \t]*(?:\n[ \t]*)?\[(\d+)\]/);
			if (tail && hostByNum.get(Number(tail[1])) === hits[i - 1].host) end += tail[0].length;
			// Peel a leading list intro before the FIRST URL: a host-matched "[n]" marker that clearly
			// STARTS a list — at answer start, on its OWN line, or right after a "Sources:" label — then the
			// label itself. A marker merely trailing prose (a sentence-final citation like "…in 2024. [1]")
			// is NOT a list item; distinguishing it from a same-line list item is impossible, so it stays.
			const lead = original.slice(0, start).match(/\[(\d+)\]\s*$/);
			if (lead && hostByNum.get(Number(lead[1])) === hits[runStart].host) {
				const before = original.slice(0, start - lead[0].length);
				if (before === "" || /\n[ \t]*$/.test(before) || TRAILING_SOURCE_LABEL.test(before)) {
					start -= lead[0].length;
				}
			}
			// Peel a dangling STANDALONE "Sources:" label — subtract only the captured label (group 1),
			// so the sentence boundary before it (e.g. the preceding period) is preserved.
			const label = original.slice(0, start).match(TRAILING_SOURCE_LABEL);
			if (label) start -= label[1].length;
			cuts.push({ start, end });
			for (let j = runStart; j <= i - 1; j++) removed.push(hits[j].core);
		}
		runStart = i;
	}
	if (cuts.length === 0) return { flagged: false, cleaned: original, removed: [] };

	// Apply cuts back-to-front so earlier indices stay valid, then tidy the seams: collapse doubled
	// spaces, pull punctuation back onto the word, and squeeze blank lines a removed block left behind.
	let out = original;
	for (let k = cuts.length - 1; k >= 0; k--) out = out.slice(0, cuts[k].start) + out.slice(cuts[k].end);
	const cleaned = out
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([.,;:!?])/g, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	if (cleaned.length < RAW_URL_MIN_KEEP) return { flagged: false, cleaned: original, removed: [] };
	return { flagged: true, cleaned, removed };
}
