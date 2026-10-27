// Open-knowledge web search for the chat — called directly over HTTPS from the
// SvelteKit server route (no self-hosted service). Engines:
//   • Wikipedia — open public knowledge; queried in English AND, when the query
//     is in another language, that language's edition (multilingual reference).
//   • Wikinews — CC-BY open-content news (the article text itself is openly
//     licensed, not just an open index over closed publisher copy); same Wikimedia
//     API as Wikipedia. Genuinely-open but thin and skews old; no reliable publish
//     date via the API, so it carries no `asOf` (see searchWikinews).
//   • Firecrawl — general open-web search (broader reach than the encyclopedic/
//     scholarly engines below; requires FIRECRAWL_API_KEY, unlike the others).
//   • OpenAlex — open scholarly index (academic/research, with real publication
//     dates + source language; no key, polite pool via mailto).
// A Google-scale open web index still does not exist — that stays an honest GAP
// on the map, not something we fake.

import { distillQuery } from "./distill";
import { correctEntityQuery } from "./entityCorrection";
import { entityNameCorrectionEnabled } from "$lib/chat/server/entityCorrectionGate";
import { decodeHTML } from "entities";
import { parseArxivAtom } from "./arxivAtom";
import { rerankByRelevance, rerankEnabled } from "./rerank";
import { reconstructAbstract, detectWikiLang } from "./searchUtil";
import { config } from "$lib/chat/server/config";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";
import { replayAwareFetch } from "$lib/chat/server/openaiClient";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import {
	classifyQueryIntent,
	unionSignals,
	type SearchIntent,
} from "$lib/chat/search/queryIntent";
import { resolveEngineBudgets, NO_RERANK_DEFAULTS } from "$lib/chat/search/engineBudgets";
import { sourcePrior } from "$lib/chat/search/sourcePrior";
import {
	classifyHost,
	screenSources,
	thinEvidenceNote,
	SOURCE_CREDIBILITY_FLAG,
	type CredibilityScreen,
} from "$lib/chat/search/sourceCredibility";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { shapeQueryForEngine } from "$lib/chat/search/shapeQuery";
import type { OpenSearchResult, SearchEngine, SearchSource } from "$lib/chat/types/Search";
import type { AssistedBy } from "$lib/chat/types/Message";
import { buildWebEvidence } from "./webEvidence";
import { isoDay, pageDateFromMetadata } from "./pageDate";
import { extractReadableHtml, readableExtractEnabled } from "$lib/chat/server/rag/readableExtract";
import { readBoundedText } from "$lib/chat/server/rag/adminIngest";
import { isValidUrlStrict, ssrfStrictFetch } from "$lib/chat/server/urlSafety";

export type { OpenSearchResult, SearchSource };
export { buildWebEvidence };

// SERVER-LOCAL candidate shape carried through retrieval + rerank, before citation numbering.
// Adds `rerankText` — a richer reranker-only document for metadata-thin engines (HF/OpenAlex), whose
// title+snippet alone under-serves the cross-encoder — on top of the wire SearchSource fields (minus
// `n`, assigned at numbering time). `rerankText` must NEVER reach the client or the model: it exists
// only so rerankByRelevance (rerank.ts) has more to score than title+snippet. numberWebSources below
// builds the final wire SearchSource explicitly, field by field, so this structurally cannot leak —
// a future field added here needs no vigilance to keep it off the wire, the no-spread build already
// drops anything it doesn't name. (CUR-78)
export type SearchCandidate = Omit<SearchSource, "n"> & { rerankText?: string };

/** Latches the "searched, but there is no reranker so nothing can be grounded" warn to once per
 *  process. See the emit site for why that condition needs its own line at all. */
let warnedNoRerankerGrounding = false;

/** SERVER-LOCAL search result carrying the grounding gate. `relevanceVerified` is true ONLY when the
 *  cross-encoder reranker actually vetted the sources (not on any fail-closed path). It must NEVER cross
 *  the client boundary: OpenSearchResult and SearchContext are both wire types (/api/search serializes
 *  OpenSearchResult raw; SearchContext is the zod-validated client payload), so a verification bit on
 *  either would let a client *claim* it. It rides this distinct type instead — the chat route reads it
 *  for the groundedWeb gate, then builds the persisted searchContext / message.webSearch from the wire
 *  fields only. See docs/plan-websearch-grounding-fix.md. */
export type WebSearchOutcome = OpenSearchResult & {
	relevanceVerified: boolean;
	timings?: WebTimings;
	/** The query-rewrite model's entry, from its own response, when it answered (CUR-3563). */
	rewriteAssist?: AssistedBy;
};

/** Where a web retrieval spent its time (CUR-2105). Server-local, like relevanceVerified: the chat route
 *  spreads it onto the `[retrieval] timing` log line and it never reaches a wire type. `engineMs` is
 *  each engine's own settle time measured from the fan-out start, so the slowest one is `enginesMs`. */
type WebTimings = {
	rewriteMs?: number;
	enginesMs: number;
	engineMs: Record<string, number>;
	/** Engines aborted by the post-Firecrawl grace window (CUR-2121), not failures. */
	cutEngines?: string[];
	rerankMs: number;
	enrichMs: number;
};

/** Reflect.get reader for non-committed env flags (GROUND_RELATIVE_*, GROUND_SCORE_PRIOR). */
function readFlag(key: string): string {
	return ((Reflect.get(config, key) as string | undefined) || "").trim();
}
function flagOn(key: string): boolean {
	return /^(1|true|on|yes)$/i.test(readFlag(key));
}
function clamp01(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 0.25;
	return v > 1 ? 1 : v;
}

const UA = "AIPotluck/0.1 (open-knowledge search; contact@aipotluck.org)";

// An engine's refusal (402 out of credit, 403 key revoked, 429 rate-limited) carries its
// status as a field, so the "engine failed" line logs it and `axiom-alert.mjs` can count refusals per
// engine. The message keeps its old `<url> → <status>` shape for anyone grepping by hand. (CUR-2597)
class EngineHttpError extends Error {
	constructor(
		url: string,
		readonly status: number
	) {
		super(`${url} → ${status}`);
		this.name = "EngineHttpError";
	}
}

function httpStatusOf(err: unknown): number | undefined {
	return err instanceof EngineHttpError ? err.status : undefined;
}

async function getJSON(
	url: string,
	signal?: AbortSignal,
	headers?: Record<string, string>
): Promise<unknown> {
	const res = await replayAwareFetch(url, { headers: { "User-Agent": UA, ...headers }, signal }, { liveOnMiss: true });
	if (!res.ok) {
		throw new EngineHttpError(url, res.status);
	}
	return res.json();
}

async function getText(url: string, signal?: AbortSignal): Promise<string> {
	const res = await replayAwareFetch(url, { headers: { "User-Agent": UA }, signal }, { liveOnMiss: true });
	if (!res.ok) {
		throw new EngineHttpError(url, res.status);
	}
	return res.text();
}

async function postJSON(
	url: string,
	body: unknown,
	signal?: AbortSignal,
	headers?: Record<string, string>
): Promise<unknown> {
	// Firecrawl is the only caller, and it bills per call. In a scenario run this replays a
	// recording like a model call does; anywhere else it is plain fetch. (SOL-219)
	const res = await replayAwareFetch(url, {
		method: "POST",
		headers: { "User-Agent": UA, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		throw new EngineHttpError(url, res.status);
	}
	return res.json();
}

// MediaWiki generator-search core, shared by Wikipedia and Wikinews — they speak
// the IDENTICAL `w/api.php` surface, differing only by host + engine label. `site`
// is the bare domain ("wikipedia.org" | "wikinews.org"); `lang` selects the
// language edition (default English); non-English sources are tagged so the
// citation can show a language chip.
async function searchMediaWiki(
	site: "wikipedia.org" | "wikinews.org",
	engine: SearchEngine,
	query: string,
	limit: number,
	lang = "en",
	signal?: AbortSignal,
	// Emit `asOf` from the page's `touched` (last-edit) timestamp. True for Wikipedia, where
	// "as of last edit" is honest. FALSE for Wikinews: there, `touched` is a maintenance-edit
	// timestamp (bots re-touch decade-old articles), so surfacing it as the news "as of" would
	// dishonestly stamp an old story as current. The real Wikinews date lives in the article
	// dateline (prose), not the API — so we omit the date rather than assert a false one.
	emitAsOf = true
): Promise<SearchCandidate[]> {
	const u = new URL(`https://${lang}.${site}/w/api.php`);
	u.search = new URLSearchParams({
		action: "query",
		generator: "search",
		gsrsearch: query,
		gsrlimit: String(limit),
		// pageimages → a small thumbnail per page, so the citation strip can show an image where the
		// page has one (the open web returning images, per the spec). UI-only (never injected into the
		// model turn — the model shouldn't reason about images it can't see).
		prop: "extracts|info|pageimages",
		piprop: "thumbnail",
		pithumbsize: "160",
		exintro: "1",
		explaintext: "1",
		exchars: "500",
		inprop: "url",
		format: "json",
		origin: "*",
	}).toString();
	const data = (await getJSON(u.toString(), signal)) as {
		query?: {
			pages?: Record<
				string,
				{
					title: string;
					extract?: string;
					fullurl?: string;
					touched?: string;
					index?: number;
					thumbnail?: { source?: string };
				}
			>;
		};
	};
	const pages = Object.values(data.query?.pages ?? {});
	pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
	return pages
		.filter((p) => p.extract?.trim())
		.map((p) => ({
			title: p.title,
			url: p.fullurl ?? `https://${lang}.${site}/wiki/${encodeURIComponent(p.title)}`,
			snippet: (p.extract ?? "").replace(/\s+/g, " ").trim().slice(0, 480),
			engine,
			...(emitAsOf && p.touched ? { asOf: p.touched } : {}), // last-edit; see emitAsOf note
			// Only Wikimedia-hosted thumbnails (upload.wikimedia.org) — a known, privacy-respecting host.
			...(p.thumbnail?.source ? { imageUrl: p.thumbnail.source } : {}),
			...(lang !== "en" ? { lang } : {}),
		}));
}

// Wikipedia: top search hits WITH intro extracts in a single generator query.
function searchWikipedia(
	query: string,
	limit: number,
	lang = "en",
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	return searchMediaWiki("wikipedia.org", "Wikipedia", query, limit, lang, signal);
}

// Wikinews: the MOST-open news source we have — article TEXT itself is CC-BY 2.5
// (reusable open content), not just an open index over closed-copyright publisher
// articles (the GDELT/MediaCloud trap). Same Wikimedia API we already speak, so no
// new dependency or key. Coverage is thin and skews old (volunteer-written); the API's `touched` field is a
// maintenance-edit timestamp, NOT the publish date — so we pass emitAsOf=false to avoid stamping an old story as current
// (the real date is in the article dateline, which the API doesn't cheaply expose).
export function searchWikinews(
	query: string,
	limit: number,
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	return searchMediaWiki("wikinews.org", "Wikinews", query, limit, "en", signal, false);
}

// Obvious conspiracy/junk domains to drop. A general open-web search engine has
// no editorial curation, so it can surface fringe sites on some queries (the
// filter is engine-agnostic and applies to any broad web index). Not exhaustive
// — these results are also labeled "broader open web" so they're never treated
// as authoritative alone.
const FRINGE = [
	"bibliotecapleyades",
	"naturalnews",
	"infowars",
	"rumormillnews",
	"abovetopsecret",
	"godlikeproductions",
	"davidicke",
	"veteranstoday",
	"globalresearch.ca",
	"zerohedge",
];
function isFringe(url: string): boolean {
	const h = url.toLowerCase();
	return FRINGE.some((d) => h.includes(d));
}

/** The date filter for the past-year half of a "latest" search. A year, because the latest
 *  of a thing that happens every few weeks or months (a central bank meeting, a race) is often more than
 *  a month old: for "the ECB's most recent rate meeting", qdr:y returns the latest decision where (CUR-3932)
 *  qdr:m returns an unrelated statement and no filter returns index pages. */
const RECENCY_TBS = "qdr:y";

/** Past-year hits first at each rank, then the unfiltered hit at that rank, deduped by URL and capped at
 *  `limit`. Interleaved rather than appended so an older "latest" survives the cap: for "the most recent
 *  total solar eclipse visible in the US", qdr:y leads with a recent eclipse that is not a US one and only
 *  the unfiltered search carries the right answer. */
function interleaveRecentFirst(
	recent: SearchCandidate[],
	unfiltered: SearchCandidate[],
	limit: number
): SearchCandidate[] {
	const out: SearchCandidate[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < Math.max(recent.length, unfiltered.length) && out.length < limit; i++) {
		for (const c of [recent[i], unfiltered[i]]) {
			if (c && !seen.has(c.url) && out.length < limit) {
				seen.add(c.url);
				out.push(c);
			}
		}
	}
	return out;
}

/** One Firecrawl search for this turn. FIRECRAWL_TBS, when set, filters every search as before. Otherwise
 *  a "latest" question runs a past-year and an unfiltered search side by side and interleaves them, so
 *  the date filter can lift recent pages without hiding the right older one. Either half failing leaves
 *  the other; both failing throws. */
async function searchFirecrawlForTurn(
	query: string,
	limit: number,
	latest: boolean,
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	if (config.FIRECRAWL_TBS || !latest) return searchFirecrawl(query, limit, signal, config.FIRECRAWL_TBS || undefined);
	const [recent, unfiltered] = await Promise.allSettled([
		searchFirecrawl(query, limit, signal, RECENCY_TBS),
		searchFirecrawl(query, limit, signal),
	]);
	if (recent.status === "rejected" && unfiltered.status === "rejected") throw unfiltered.reason;
	return interleaveRecentFirst(
		recent.status === "fulfilled" ? recent.value : [],
		unfiltered.status === "fulfilled" ? unfiltered.value : [],
		limit
	);
}

// Firecrawl: general open-web search, JSON API (POST /v2/search, Bearer auth).
// Auth: FIRECRAWL_API_KEY (required — no keyless public fallback like the other
// engines here). When FIRECRAWL_TBS names a time-based search filter (e.g.
// "sbd:1,qdr:m" — sort-by-date within the last month; see docs.firecrawl.dev's
// `qdr:h|d|w|m|y` predefined ranges, combinable with `sbd:1`), it's applied to bias
// results by recency — the structural fix for stale-source drift, since Firecrawl's
// `web` results (like Marginalia's before it) never return a per-result publish date.
async function searchFirecrawl(
	query: string,
	limit: number,
	signal?: AbortSignal,
	tbs?: string
): Promise<SearchCandidate[]> {
	const apiKey = config.FIRECRAWL_API_KEY;
	if (!apiKey) {
		throw new Error("FIRECRAWL_API_KEY not configured");
	}
	try {
		const data = (await postJSON(
			"https://api.firecrawl.dev/v2/search",
			{ query, limit, ...(tbs ? { tbs } : {}) },
			signal,
			{ Authorization: `Bearer ${apiKey}` }
		)) as { data?: { web?: { url: string; title: string; description?: string }[] } };
		return (data.data?.web ?? [])
			.filter((r) => r.url && !isFringe(r.url))
			.map((r) => ({
				title: r.title?.trim() || r.url,
				url: r.url,
				// 500, not 300: a SERP description's disambiguating clause can sit right after an
				// ambiguous opening clause (a headline like "CEO X replaced by Y at an event" reads as a
				// title change unless the event context that follows survives the cut). 500 is still a
				// snippet, not a full-page excerpt, just wide enough to usually keep a description's second
				// clause intact. A description can be raw page markdown (a release list arriving as
				// logo-image links), which leads the model to pair one row's company with the next row's
				// model, so it is flattened to text first (CUR-2207).
				snippet: inlineMarkdownToText(r.description ?? "").slice(0, 500),
				engine: "Firecrawl" as const,
			}));
	} catch (err) {
		// Length only, never the query text itself -- same house rule CUR-914 applied to
		// entityCorrection.ts and rag/localStore.ts already follow (this logger ships to Axiom in prod). (CUR-918)
		logger.warn(
			{ err, status: httpStatusOf(err), queryLength: query.length },
			"[search] Firecrawl search call failed"
		);
		throw err;
	}
}

/** Markdown syntax → the text a reader sees, on one line. Images go; a link becomes its text; links
 *  that sit back to back (a listing's rows, each one link) get "; " between them, so one row's
 *  trailing label ("Anthropic•6d ago") does not run into the next row's name (CUR-2207). Bold
 *  markers (`**` only; `__` is too often a dunder name), backslash line breaks and heading markers
 *  go. Only markdown's own syntax is touched, never the words. */
function inlineMarkdownToText(text: string): string {
	return text
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images, including a logo nested inside a link
		.replace(/(\]\([^)]*\))\s*(?=\[)/g, "$1; ") // back-to-back links: keep the rows apart
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their visible text
		.replace(/\\(?=\s|$)/g, " ") // a backslash hard line break
		.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1") // bold; `__` stays, so `__init__` survives
		.replace(/(^|\s)#{1,6}\s+/g, "$1") // heading markers, at the start or mid-description
		.replace(/\s+/g, " ")
		.trim();
}

// Bounded enrichment: when a Firecrawl result's SERP-style description is too thin to
// cite meaningfully, or the overall kept set is sparse, spend a few extra /v2/scrape
// calls to replace the thin snippet with real per-page content.
// Cheap common case stays cheap (plain search, no scrape); this only pays for richer
// content on the minority of turns where the cheap tier would leave citations thin.
//
// Uses formats:["markdown"], NOT ["summary"]: `summary` runs an LLM call server-side and takes
// 8-11s per page, which blows any latency budget this bounded pass
// could afford (the enrichment timeout below would abort it EVERY time, paying the full timeout for
// zero benefit). `markdown` skips that step and returns well under 2.5s cold. We condense it
// ourselves in markdownToExcerpt below instead of relying on Firecrawl's LLM summary.
// `onlyMainContent` keeps a site's cookie consent banner, so a GOV.UK page's markdown opens on
// "Cookies on GOV.UK" (its first 663 characters), which X-ray would quote as the source (CUR-4198). These
// selectors name the banner by its markup, never by its wording, so they hold in any language: GOV.UK's
// design-system banner, the common class/id naming, and the OneTrust and Cookiebot consent managers.
// With them, a GOV.UK statistics page's markdown opens on the page's own title.
const FIRECRAWL_EXCLUDE_TAGS = [
	"#global-cookie-message",
	"[data-module=cookie-banner]",
	"[class*=cookie-banner]",
	"[id*=cookie-banner]",
	"[class*=cookie-consent]",
	"[id*=cookie-consent]",
	"#onetrust-consent-sdk",
	"#CybotCookiebotDialog",
];

const FIRECRAWL_SCRAPE = (url: string) => ({
	url,
	formats: ["markdown"],
	onlyMainContent: true,
	excludeTags: FIRECRAWL_EXCLUDE_TAGS,
});

export function markdownToExcerpt(markdown: string, maxChars: number): string {
	const lines = markdown
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith(">")) // drop blanks + blockquote asides (CTAs, pull-quotes)
		.map(inlineMarkdownToText)
		.filter((l) => l.length >= 30); // drop nav crumbs / labels / lone words

	let out = "";
	for (const line of lines) {
		out = out ? `${out} ${line}` : line;
		if (out.length >= maxChars) break;
	}
	return out.slice(0, maxChars).trim();
}

async function enrichFirecrawlSnippet(
	url: string,
	signal?: AbortSignal
): Promise<{ snippet: string; asOf?: string } | undefined> {
	try {
		const data = (await postJSON(
			"https://api.firecrawl.dev/v2/scrape",
			FIRECRAWL_SCRAPE(url),
			signal,
			{ Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` }
		)) as { data?: { markdown?: string | null; metadata?: Record<string, unknown> } };
		const markdown = data.data?.markdown;
		if (!markdown) return undefined;
		const excerpt = markdownToExcerpt(markdown, 900); // see the 500-char SERP snippet cap above for why
		if (!excerpt) return undefined;
		const asOf = pageDateFromMetadata(data.data?.metadata);
		return { snippet: excerpt, ...(asOf ? { asOf } : {}) };
	} catch (err) {
		logger.warn({ err, url }, "[search] Firecrawl enrichment scrape failed — keeping original snippet");
		return undefined;
	}
}

// How much of a page the person linked the model gets to read. The 900-char enrichment
// excerpt above is sized for citing a search hit; a "summarise this article" turn needs the body, and a
// 500-char search snippet of that exact article leaves the model saying it can't read it.
// About 2k tokens: a long article's argument, bounded so one link can't crowd out the conversation. (CUR-1897)
const LINKED_PAGE_CHARS = 8000;
const LINKED_PAGE_TIMEOUT_MS = 8000;

/** Read the one page the person linked in their message (see linkedUrl.ts for which URLs qualify)
 *  and return it as a source candidate, or undefined when it can't be read — an error status, an empty
 *  page, a timeout, or no way to read it at all. Undefined never throws into the turn.
 *
 *  Firecrawl first. With `readable-extract` on (CUR-2152), a page Firecrawl can't read, or any page
 *  when there is no Firecrawl key, is fetched from this deployment and run through Readability.
 *  `skipFirecrawl` is the `linked_page_firecrawl_down` fault (faultInjection.ts), which is the only way
 *  to exercise that path on a preview that holds a key. */
export async function fetchLinkedPage(
	url: string,
	opts: { skipFirecrawl?: boolean } = {}
): Promise<SearchCandidate | undefined> {
	// House rule (CUR-918): this logger ships to Axiom, and a URL the person typed can carry a share
	// token or a signed query string, so only the host is ever logged.
	const host = new URL(url).hostname;
	if (config.FIRECRAWL_API_KEY && !opts.skipFirecrawl) {
		const page = await scrapeLinkedPage(url, host);
		if (page) return page;
	}
	if (!readableExtractEnabled()) return undefined;
	return fetchLinkedPageDirect(url, host);
}

async function scrapeLinkedPage(url: string, host: string): Promise<SearchCandidate | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LINKED_PAGE_TIMEOUT_MS);
	try {
		const data = (await postJSON(
			"https://api.firecrawl.dev/v2/scrape",
			FIRECRAWL_SCRAPE(url),
			controller.signal,
			{ Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` }
		)) as { data?: { markdown?: string | null; metadata?: Record<string, unknown> & { title?: string; statusCode?: number } } };
		const status = data.data?.metadata?.statusCode;
		const excerpt = markdownToExcerpt(data.data?.markdown ?? "", LINKED_PAGE_CHARS);
		if ((status && status >= 400) || !excerpt) {
			logger.warn({ host, status, empty: !excerpt }, "[search] linked page unreadable");
			return undefined;
		}
		const title = decodeHTML(data.data?.metadata?.title?.trim() || host);
		const asOf = pageDateFromMetadata(data.data?.metadata);
		return { title: `Linked page: ${title}`, url, snippet: excerpt, engine: "Firecrawl", ...(asOf ? { asOf } : {}) };
	} catch (err) {
		logger.warn({ host, err: (err as Error)?.name }, "[search] linked page fetch failed");
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// The direct read runs on THIS deployment's network, unlike Firecrawl's, so it goes through
// the same strict SSRF guard admin ingest uses (https only, no private or link-local address after DNS).
// Its own budget, shorter than Firecrawl's: it only runs after Firecrawl has already failed or is absent,
// and the turn is waiting on it. (CUR-2152)
const LINKED_PAGE_DIRECT_TIMEOUT_MS = 5000;
const LINKED_PAGE_DIRECT_MAX_BYTES = 2_000_000;

async function fetchLinkedPageDirect(url: string, host: string): Promise<SearchCandidate | undefined> {
	if (!isValidUrlStrict(url)) {
		logger.warn({ host, outcome: "refused" }, "[search] linked page direct read");
		return undefined;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LINKED_PAGE_DIRECT_TIMEOUT_MS);
	const t0 = Date.now();
	try {
		const res = await ssrfStrictFetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "User-Agent": UA, accept: "text/html;q=1,*/*;q=0.1" },
		});
		const contentType = (res.headers.get("content-type") || "").toLowerCase();
		if (!res.ok || !contentType.includes("text/html")) {
			logger.warn(
				{ host, outcome: "unreadable", status: res.status, contentType: contentType.split(";")[0] },
				"[search] linked page direct read"
			);
			return undefined;
		}
		const html = await readBoundedText(res, LINKED_PAGE_DIRECT_MAX_BYTES);
		const { title, text, publishedTime } = await extractReadableHtml(html, "linked-page");
		const excerpt = text.replace(/\s+/g, " ").trim().slice(0, LINKED_PAGE_CHARS);
		if (!excerpt) {
			logger.warn({ host, outcome: "empty", ms: Date.now() - t0 }, "[search] linked page direct read");
			return undefined;
		}
		logger.info({ host, outcome: "read", ms: Date.now() - t0, chars: excerpt.length }, "[search] linked page direct read");
		// The extractor already decoded the title, so decoding it again would turn a literal "&amp;lt;" into "<".
		const asOf = isoDay(publishedTime);
		return { title: `Linked page: ${title || host}`, url, snippet: excerpt, engine: "Direct", ...(asOf ? { asOf } : {}) };
	} catch (err) {
		logger.warn({ host, outcome: "failed", err: (err as Error)?.name }, "[search] linked page direct read");
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// OpenAlex: open scholarly index (works metadata). Keyless — the free "polite
// pool" only asks for a mailto. Each work carries a real publication_date and a
// language, so academic sources get honest dates (which Firecrawl's web results can't give).
interface OpenAlexWork {
	id: string;
	title?: string;
	doi?: string | null;
	publication_date?: string;
	language?: string;
	abstract_inverted_index?: Record<string, number[]> | null;
	primary_location?: {
		landing_page_url?: string | null;
		source?: { display_name?: string } | null;
	};
	open_access?: { oa_url?: string | null };
}
/** OpenAlex reads `?` and `*` in `search` as wildcards and answers 400 to them (CUR-3833), so a
 * question-shaped query ("what is CRISPR?") returned nothing. Neither carries meaning for a
 * full-text search, so drop them. */
function openAlexSearchText(query: string): string {
	return query.replace(/[?*]/g, " ").replace(/\s+/g, " ").trim();
}

async function searchOpenAlex(
	query: string,
	limit: number,
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	const text = openAlexSearchText(query);
	if (!text) return [];
	const u = new URL("https://api.openalex.org/works");
	u.searchParams.set("search", text);
	u.searchParams.set("per-page", String(limit));
	u.searchParams.set("mailto", "contact@aipotluck.org"); // polite pool (no key needed)
	const data = (await getJSON(u.toString(), signal)) as { results?: OpenAlexWork[] };
	return (data.results ?? [])
		.filter((w) => w.title?.trim())
		.map((w) => {
			const venue = w.primary_location?.source?.display_name;
			const abstract = reconstructAbstract(w.abstract_inverted_index);
			const snippet = (
				abstract || [venue, w.publication_date?.slice(0, 4)].filter(Boolean).join(" · ")
			)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 360);
			const url = w.doi || w.primary_location?.landing_page_url || w.open_access?.oa_url || w.id;
			// The snippet drops venue whenever an abstract exists (see snippet above) — the
			// reranker gets both, uncapped here (rerank.ts's own 1200-char cap applies at scoring time). (CUR-78)
			const rerankText = [venue, abstract].filter(Boolean).join(" · ") || undefined;
			return {
				title: (w.title ?? "").trim(),
				url,
				snippet,
				engine: "OpenAlex" as const,
				...(w.publication_date ? { asOf: w.publication_date } : {}),
				...(w.language && w.language !== "en" ? { lang: w.language } : {}),
				...(rerankText ? { rerankText } : {}),
			};
		})
		.filter((s) => s.url && s.snippet);
}

// arXiv: open preprint server (cs/physics/math/…). The ONLY engine here that can be sorted by true
// recency — sortBy=submittedDate gives the newest papers first, which is exactly what the citation-ranked
// OpenAlex (oldest-most-cited) and the encyclopedic Wikipedia can't. Keyless. Returns Atom XML, which
// parseArxivAtom reads (arxivAtom.ts).
async function searchArxiv(
	query: string,
	limit: number,
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	const u = new URL("https://export.arxiv.org/api/query");
	u.searchParams.set("search_query", `all:${query}`);
	// RELEVANCE, not submittedDate: date-sort returns the newest papers matching ANY term loosely (a
	// recent math paper that merely contains "model"), which the downstream rerank then drops as
	// off-topic. Relevance surfaces ON-topic preprints — and arXiv's preprints are far more current than
	// OpenAlex's citation-ranked classics, so this still broadens recency where it's relevant.
	u.searchParams.set("sortBy", "relevance");
	u.searchParams.set("max_results", String(limit));
	const xml = await getText(u.toString(), signal);
	return parseArxivAtom(xml);
}

// Hugging Face Hub: the open model/dataset registry — the only engine that knows what's actually been
// RELEASED (with a real createdAt date). Sorted by downloads (notable, not the createdAt firehose of junk
// fine-tunes), keyless for public listings. The basic listing has no description, so the snippet is
// synthesized from what it does return (task · popularity · age · tags) — thin, but the model NAME + date
// is the answer for "what open models exist / released" queries. Off-topic hits on a non-model query are
// dropped by the cross-encoder rerank downstream.
interface HFModel {
	id: string;
	downloads?: number;
	likes?: number;
	createdAt?: string;
	pipeline_tag?: string;
	tags?: string[];
}
async function searchHuggingFace(
	query: string,
	limit: number,
	signal?: AbortSignal
): Promise<SearchCandidate[]> {
	const u = new URL("https://huggingface.co/api/models");
	u.searchParams.set("search", query);
	u.searchParams.set("sort", "downloads");
	u.searchParams.set("direction", "-1");
	u.searchParams.set("limit", String(limit));
	const data = (await getJSON(u.toString(), signal)) as HFModel[];
	return (Array.isArray(data) ? data : [])
		.filter((m) => m.id)
		.map((m) => {
			const dl = typeof m.downloads === "number" ? m.downloads : 0;
			const dlStr =
				dl >= 1_000_000
					? `${(dl / 1_000_000).toFixed(1)}M`
					: dl >= 1_000
						? `${Math.round(dl / 1_000)}k`
						: String(dl);
			const libraryTags = (m.tags ?? [])
				.filter((t) => !t.includes(":") && t !== m.pipeline_tag)
				.slice(0, 4);
			const snippet = [
				m.pipeline_tag ? `Open model · ${m.pipeline_tag}` : "Open model",
				`${dlStr} downloads`,
				m.createdAt ? `released ${m.createdAt.slice(0, 10)}` : null,
				libraryTags.length ? libraryTags.join(", ") : null,
			]
				.filter(Boolean)
				.join(" · ");
			// The snippet caps library tags at 4 and never includes the id path — the id itself
			// carries query-relevant terms (org/model-name) the thin snippet doesn't. Full tag list here,
			// uncapped (rerank.ts's own 1200-char cap applies at scoring time). (CUR-78)
			const rerankText =
				[m.id, m.pipeline_tag, (m.tags ?? []).join(", ")].filter(Boolean).join(" · ") || undefined;
			return {
				title: m.id,
				url: `https://huggingface.co/${m.id}`,
				snippet,
				engine: "Hugging Face" as const,
				...(m.createdAt ? { asOf: m.createdAt.slice(0, 10) } : {}),
				...(rerankText ? { rerankText } : {}),
			};
		});
}

function dedupe(items: SearchCandidate[]): SearchCandidate[] {
	const seen = new Set<string>();
	const out: SearchCandidate[] = [];
	for (const it of items) {
		const key = it.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(it);
	}
	return out;
}

/** The web-retrieval result BEFORE citation numbering: reranked, enriched hits in final order, but
 *  not yet assigned `[n]`. numberWebSources turns this into a WebSearchOutcome once the
 *  community count is known (community-first). Kept as its own type so the chat route can run retrieval
 *  CONCURRENTLY with RAG and number ONCE at the join — never committing web to [1..m] that would collide
 *  with community [1..k] (TTFT plan §5.1). openSearch itself numbers immediately (startAt) for the
 *  manual /api/search + auto paths, where the offset is already known. */
export type WebRetrieval = {
	query: string;
	merged: SearchCandidate[];
	asOf: string;
	relevanceVerified: boolean;
	timings?: WebTimings;
	/** Set only when the source-credibility-filter flag is on (CUR-2423): how many candidates the host
	 *  screen kept and dropped before the rerank. Server-local; numberWebSources reads it. */
	credibility?: CredibilityScreen;
	/** The query-rewrite model's entry, from its own response, when it answered (CUR-3563). */
	rewriteAssist?: AssistedBy;
};

/** Options shared by retrieveWeb + openSearch (openSearch adds `startAt`). */
export type RetrieveWebOpts = {
	wikipedia?: number;
	wikinews?: number;
	firecrawl?: number;
	openalex?: number;
	arxiv?: number;
	huggingface?: number;
	keep?: number;
	timeoutMs?: number;
	perEngineTimeoutMs?: number;
	/** Firecrawl-specific cap, independent of perEngineTimeoutMs and NOT clamped to timeoutMs — see
	 *  DEFAULT_FIRECRAWL_TIMEOUT_MS below for why it needs its own, longer budget. */
	firecrawlTimeoutMs?: number;
	/** How long the other engines may keep running once primary Firecrawl has returned results
	 *  (CUR-2121). See DEFAULT_AFTER_FIRECRAWL_GRACE_MS. */
	afterFirecrawlGraceMs?: number;
	recency?: boolean;
	/** The person wants the latest of something (asksForTheLatest): Firecrawl adds a past-year search. */
	latest?: boolean;
	rawSignals?: Set<SearchIntent>;
	preShaped?: boolean;
	/** Threaded through to the entity-name correction branch's model call (CUR-877) — same
	 *  App.Locals every other side-call in this subtree takes. Undefined is fine; the correction
	 *  call degrades the same way any other side-call does without it. */
	locals?: App.Locals;
	/** Written as the leg moves, so a caller that gives up on it can say where it was (CUR-4089). */
	progress?: WebProgress;
};

/** Where a web leg is: the stage it reached, and during the fan-out which engines have not settled. A
 *  caller's deadline reads it to name the stage that held the leg, which no log line inside says. */
export type WebProgress = {
	stage: "rewrite" | "engines" | "rerank" | "enrich" | "done";
	pending: Set<string>;
};

// Firecrawl is a live web crawl, not a fast static-index lookup like the other engines here, and
// routinely takes longer than the shared perEngineTimeoutMs meant to protect against a genuinely-
// stalled FAST engine (that cap's own comment at the call site names arXiv as the usual offender).
// Cold /v2/search calls range from under 1s to about 9s, so a 4.5s shared budget aborts many of
// them (CUR-633). Firecrawl therefore gets its own longer cap and does not follow the master abort that
// bounds the fast engines (see followMaster in runEngine below). Promise.allSettled already waits for
// it regardless, and the retrieval heartbeat (conversation/[id]/+server.ts) keeps the client's
// first-token watchdog from firing during a legitimately-slow retrieval. This matches /api/search's
// own 9000ms timeoutMs, which never overrides perEngineTimeoutMs down from it.
const DEFAULT_FIRECRAWL_TIMEOUT_MS = 9000;

// Once primary Firecrawl returns results, the other engines get this long to finish before the master
// controller cuts them (CUR-2121). Firecrawl supplies nearly every source an answer cites, while the
// slowest fast engine (arXiv, p90 about 3.5s) would otherwise set the whole fan-out's end. The entity-correction branch
// does not follow the master abort, so it still runs to firecrawlCap. An empty Firecrawl result arms
// nothing, and every engine runs to its own cap as before.
const DEFAULT_AFTER_FIRECRAWL_GRACE_MS = 300;

/** Assign community-first citation numbers (`startAt+1 …`) to reranked hits and build the matching
 *  evidence block. The SINGLE numbering authority: openSearch and the chat route's deferred-numbering
 *  join both route through it, so no code path can number sources and evidence differently. Pure. */
export function numberWebSources(
	merged: SearchCandidate[],
	startAt: number,
	/** WebRetrieval.credibility. When present the screen ran: label official and academic sources, and
	 *  warn the model when it left too few (CUR-2423). */
	credibility?: CredibilityScreen
): { sources: SearchSource[]; evidence: string } {
	// Explicit no-spread build — names every wire field, so a server-local-only field on
	// SearchCandidate (rerankText today, whatever's added next) can never cross into the client- and
	// model-facing SearchSource just by riding along in a `{...s}` spread. (CUR-78)
	const sources: SearchSource[] = merged.map((s, i) => ({
		n: startAt + i + 1,
		title: s.title,
		url: s.url,
		snippet: s.snippet,
		engine: s.engine,
		...(s.asOf ? { asOf: s.asOf } : {}),
		...(s.lang ? { lang: s.lang } : {}),
		...(s.imageUrl ? { imageUrl: s.imageUrl } : {}),
	}));
	if (!credibility) return { sources, evidence: buildWebEvidence(sources) };
	const evidence = buildWebEvidence(sources, {
		sourceType: (s) => {
			const type = classifyHost(s.url);
			return type === "official" || type === "academic" ? type : undefined;
		},
		note: thinEvidenceNote(credibility, sources.length),
	});
	return { sources, evidence };
}

/** Retrieve + rerank + enrich open-web hits WITHOUT assigning citation numbers.
 *  Returns the final-ordered `merged` list; the caller numbers it (numberWebSources) once the
 *  community-first offset is known. openSearch is this + immediate numbering (startAt). */
export async function retrieveWeb(query: string, opts: RetrieveWebOpts = {}): Promise<WebRetrieval> {
	// With a reranker configured, cast a WIDER net and let the cross-encoder pick
	// the best — recall from the wide retrieval, precision from the rerank. Without
	// one, keep the original tight limits (no extra latency, unchanged behavior).
	const reranking = rerankEnabled();
	const {
		keep = 8,
		timeoutMs = 4500,
		perEngineTimeoutMs = timeoutMs,
		recency = false,
		latest = false,
		rawSignals,
		preShaped = false,
	} = opts;
	const searchQuery = preShaped ? (query ?? "").trim() : distillQuery(query);
	const { intent, signals: finalizedSignals, confident } = classifyQueryIntent(searchQuery);
	const signals = unionSignals(rawSignals, finalizedSignals);
	const base = reranking ? resolveEngineBudgets({ intent, confident, signals }) : NO_RERANK_DEFAULTS;
	const wikipedia = opts.wikipedia ?? base.wikipedia;
	const wikinews = opts.wikinews ?? base.wikinews;
	const firecrawl = opts.firecrawl ?? base.firecrawl;
	const openalex = opts.openalex ?? base.openalex;
	const arxiv = opts.arxiv ?? base.arxiv;
	const huggingface = opts.huggingface ?? base.huggingface;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const asOf = new Date().toISOString();
	const perCap = Math.min(perEngineTimeoutMs, timeoutMs);
	// followMaster=false (Firecrawl only) skips subscribing to the master controller's early abort, so
	// a fast-engine-sized master timeoutMs can't cut Firecrawl off before its own, longer capMs elapses.
	// Promise.allSettled below still waits for it either way — this only changes WHEN it gets aborted.
	const runEngine = (
		fn: (signal: AbortSignal) => Promise<SearchCandidate[]>,
		capMs: number = perCap,
		followMaster = true
	): Promise<SearchCandidate[]> => {
		const child = new AbortController();
		let onMasterAbort: (() => void) | undefined;
		if (followMaster) {
			onMasterAbort = () => child.abort(controller.signal.reason);
			if (controller.signal.aborted) child.abort(controller.signal.reason);
			else controller.signal.addEventListener("abort", onMasterAbort, { once: true });
		}
		const t = setTimeout(() => child.abort(), capMs);
		// The cap settles the engine itself rather than trusting the fetch to honour its abort: an
		// engine call can stay pending well past its cap and hold the fan-out until the leg deadline
		// (CUR-4089). A fetch that does honour it rejects the same way, a moment earlier.
		const cut = new Promise<never>((_, reject) => {
			if (child.signal.aborted) reject(child.signal.reason);
			else child.signal.addEventListener("abort", () => reject(child.signal.reason), { once: true });
		});
		cut.catch(() => {});
		return Promise.race([fn(child.signal), cut]).finally(() => {
			clearTimeout(t);
			if (onMasterAbort) controller.signal.removeEventListener("abort", onMasterAbort);
		});
	};
	// Promise.allSettled below silently discards a rejection's reason — a missing API key, a network
	// error, and a genuine "engine ran, found nothing" all render identically as zero contributed
	// results, with NOTHING in the logs to tell them apart. With no
	// FIRECRAWL_API_KEY configured, every Firecrawl call throws "not configured", and the turn's own
	// trace reads "searched the open web, but no result cleared the relevance bar" — the same copy a
	// real empty search produces. Tag each engine's failure with its name and log it HERE,
	// at the source, so `allSettled` only ever sees fulfilled promises and nothing downstream can lose
	// the reason. A "not configured" message gets its own louder line — that class is an environment
	// bug, not the search having an off day, and the two need to read differently in Axiom.
	let failedEngines = 0;
	const engineMs: Record<string, number> = {};
	const cutEngines: string[] = [];
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let graceCut = false;
	const armGrace = () => {
		if (graceTimer || controller.signal.aborted) return;
		graceTimer = setTimeout(() => {
			graceCut = true;
			controller.abort();
		}, opts.afterFirecrawlGraceMs ?? DEFAULT_AFTER_FIRECRAWL_GRACE_MS);
	};
	const fanoutStart = Date.now();
	const progress = opts.progress;
	if (progress) progress.stage = "engines";
	const namedEngine = (
		name: string,
		p: Promise<SearchCandidate[]>
	): Promise<SearchCandidate[]> => {
		progress?.pending.add(name);
		return p.finally(() => {
			engineMs[name] = Date.now() - fanoutStart;
			progress?.pending.delete(name);
		}).catch((err) => {
			// Cut by the post-Firecrawl grace window: the turn already has its sources, so this is a
			// decision, not a failure, and it must not read as one in Axiom. Only the abort itself counts;
			// an engine that fails for its own reason inside the window still logs as a failure.
			if (graceCut && (err as { name?: unknown } | null)?.name === "AbortError") {
				cutEngines.push(name);
				return [];
			}
			failedEngines++;
			const misconfigured = err instanceof Error && /not configured/i.test(err.message);
			if (misconfigured) {
				logger.error({ engine: name, err }, "[search] engine unavailable — misconfigured, not empty");
				void captureServerException(err, { routeId: `search-engine:${name}` });
			} else {
				logger.warn(
					{ engine: name, status: httpStatusOf(err), err },
					"[search] engine failed — contributing zero results"
				);
			}
			return [];
		});
	};
	try {
		const wikiLang = detectWikiLang(searchQuery);
		const foldWiki = reranking && !!wikiLang;
		const enWiki = foldWiki ? Math.ceil(wikipedia / 2) : wikipedia;
		const nonEnWiki = wikiLang ? (reranking ? Math.floor(wikipedia / 2) : wikipedia) : 0;
		const wikiQuery = shapeQueryForEngine(searchQuery, "Wikipedia");
		const wikinewsQuery = shapeQueryForEngine(searchQuery, "Wikinews");
		const engines: Promise<SearchCandidate[]>[] = [];
		if (arxiv > 0)
			engines.push(namedEngine("arxiv", runEngine((s) => searchArxiv(searchQuery, arxiv, s))));
		if (huggingface > 0)
			engines.push(
				namedEngine("huggingface", runEngine((s) => searchHuggingFace(searchQuery, huggingface, s)))
			);
		if (enWiki > 0)
			engines.push(
				namedEngine("wikipedia-en", runEngine((s) => searchWikipedia(wikiQuery, enWiki, "en", s)))
			);
		if (wikinews > 0)
			engines.push(
				namedEngine("wikinews", runEngine((s) => searchWikinews(wikinewsQuery, wikinews, s)))
			);
		if (firecrawl > 0) {
			const firecrawlCap = opts.firecrawlTimeoutMs ?? DEFAULT_FIRECRAWL_TIMEOUT_MS;
			engines.push(
				namedEngine(
					"firecrawl",
					runEngine((s) => searchFirecrawlForTurn(searchQuery, firecrawl, latest, s), firecrawlCap, false).then(
						(hits) => {
							if (hits.length > 0) armGrace();
							return hits;
						}
					)
				)
			);
			// Entity-name correction (CUR-877): fires ALONGSIDE the primary Firecrawl call, sharing its
			// budget and its followMaster=false exemption, rather than as a sequential pre-check that
			// would tax every search with its own model-call latency. Only worth attempting when
			// Firecrawl is actually configured — with no key, searchFirecrawl throws immediately
			// regardless of what a correction finds, so there is nothing for a correction to unlock, and
			// running the model call anyway would be pure waste (see entityCorrection.ts).
			//
			// Also gated on entityNameCorrectionEnabled() (default-on fallback, see
			// entityCorrectionGate.ts). (CUR-917)
			if (config.FIRECRAWL_API_KEY && entityNameCorrectionEnabled()) {
				engines.push(
					namedEngine(
						"firecrawl-corrected",
						runEngine(
							async (s) => {
								const corrected = await correctEntityQuery(searchQuery, opts.locals);
								return corrected ? searchFirecrawlForTurn(corrected, firecrawl, latest, s) : [];
							},
							firecrawlCap,
							false
						)
					)
				);
			}
		}
		if (openalex > 0)
			engines.push(
				namedEngine("openalex", runEngine((s) => searchOpenAlex(searchQuery, openalex, s)))
			);
		if (wikiLang && nonEnWiki > 0)
			engines.push(
				namedEngine(
					`wikipedia-${wikiLang}`,
					runEngine((s) => searchWikipedia(wikiQuery, nonEnWiki, wikiLang, s))
				)
			);
		const settled = await Promise.allSettled(engines);
		const enginesMs = Date.now() - fanoutStart;
		// Engines that ran and found nothing are an empty search. Every engine throwing is a failure that
		// reads the same way to the user, so that one is the departure.
		if (engines.length > 0 && failedEngines === engines.length) {
			failOpenDeparture("search", "every-engine-failed", { engines: engines.length });
		}

		let merged = dedupe(settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))).filter(
			(s) => s.snippet
		);

		// The host screen runs BEFORE the rerank, so a removed forum or low-credibility page can
		// never be refilled into the top-K when too few good pages survive. Too few reaches the model as
		// a thin-evidence note (numberWebSources) and is never topped up. (CUR-2423)
		let credibility: CredibilityScreen | undefined;
		if (flagEnabledOr(SOURCE_CREDIBILITY_FLAG, () => false)) {
			const screened = screenSources(merged);
			merged = screened.kept;
			credibility = screened.screen;
		}

		// Cross-encoder rerank by true query-relevance, keeping the best `keep` and
		// dropping clearly off-topic hits (the failure mode that returned generic AI
		// pages for an "EU AI Act" query). On the GATE path (allowEmpty) it FAILS
		// CLOSED: a disabled/failed/unverified reranker yields [] (relevanceVerified
		// stays false → the turn answers ungrounded), NOT raw retrieval order — grounding
		// on unvetted junk is the failure. Without a reranker, still cap to `keep` below.
		//
		// GROUND_RELEVANCE_FLOOR is the citation-honesty gate (with allowEmpty): BGE
		// relevance scores are sharply BIMODAL, so a conservative floor drops garbage AND —
		// when the open engines genuinely have nothing on the query (e.g. "open source AI
		// funding last MONTH", which they can't serve) — returns ZERO sources. Empty sources
		// ⇒ the turn answers honestly ungrounded (no fabricated [n] citations on irrelevant
		// pages). Deliberately low so it never drops a real match.
		//
		// Measured with evals/rerank-floor-probe.mjs (BAAI/bge-reranker-v2-m3, funder + EU-AI-Act
		// queries): direct matches ~0.997–0.9996, off-topic junk
		// ~0.00002, tangential ~0.0017–0.004. So junk does NOT slip through at 0.02 (it's ~1000×
		// below) and strong matches are never near it — the "tune up if junk slips through"
		// condition is NOT met. Keep 0.02 rather than raise: the probe characterizes only the
		// STRONG-match and junk ends, not moderate matches in 0.02–0.5, so raising would gamble
		// on dropping an unmeasured real partial match — the exact risk this floor guards against.
		const GROUND_RELEVANCE_FLOOR = 0.02;
		const relativeFloor = flagOn("GROUND_RELATIVE_FLOOR")
			? {
					ratio: clamp01(Number(readFlag("GROUND_RELATIVE_RATIO")) || 0.25),
					minTop: Math.max(0, Number(readFlag("GROUND_RELATIVE_MINTOP")) || 0.5),
				}
			: undefined;
		const nowMs = Date.parse(asOf);
		const scoreAdjust = flagOn("GROUND_SCORE_PRIOR")
			? (c: SearchCandidate, raw: number) => sourcePrior(c, raw, { recency, nowMs })
			: undefined;
		let relevanceVerified = false;
		if (progress) progress.stage = "rerank";
		const rerankStart = Date.now();
		if (reranking) {
			const before = merged.length;
			const rr = await rerankByRelevance(searchQuery, merged, {
				topK: keep,
				minScore: GROUND_RELEVANCE_FLOOR,
				allowEmpty: true,
				...(relativeFloor ? { relativeFloor } : {}),
				...(scoreAdjust ? { scoreAdjust } : {}),
				timeoutMs: 6000,
			});
			merged = rr.items;
			relevanceVerified = rr.verified;
			if (merged.length === 0 && before > 0) {
				// Length only, never the query text -- see the note at the Firecrawl catch above. (CUR-918)
				logger.info(
					{ queryLength: searchQuery.length, retrieved: before, verified: rr.verified },
					"[search] no sources survived reranking — answering ungrounded (no fabricated citations)"
				);
			}
		} else if (merged.length > 0 && !warnedNoRerankerGrounding) {
			// The counterpart of the log above, for the opposite cause and with no other trace.
			//
			// With no reranker, relevanceVerified stays false, so groundedWeb is false
			// (conversation/[id]/+server.ts) and evidence is fed to the model ONLY when groundedWeb.
			// These sources were retrieved and are about to be thrown away at that gate — the turn
			// answers ungrounded having paid for the search.
			//
			// rerankEnabled()'s warn (rerank.ts:49) fires only when RERANK_KIND
			// is set and RERANK_MODEL is not; with NEITHER set — the local default, since RERANK_MODEL
			// is set in production and preview but not local dev — it never fires. The only remaining signal is
			// groundedWeb:false in the [retrieval] line, whose own comment calls it "the smoking gun for
			// a cold/failed reranker in prod". Locally that names the wrong suspect: there is no
			// reranker to be cold.
			//
			// Warn-once per process, not per turn: this is a configuration fact that cannot change
			// between requests, and in an environment where it holds it would otherwise fire on every
			// searched turn.
			warnedNoRerankerGrounding = true;
			// Length only, never the query text -- see the note at the Firecrawl catch above. (CUR-918)
			logger.warn(
				{ queryLength: searchQuery.length, retrieved: merged.length },
				"[search] no reranker configured (RERANK_MODEL unset) — retrieved sources cannot be relevance-verified, so this and every searched turn answers UNGROUNDED. Not a cold reranker; there isn't one."
			);
		}
		// Always cap to `keep` — OUTSIDE the rerank branch. A successful rerank already returns ≤keep, and
		// a failed/unverified rerank now returns [] on the gate path (fail-closed, above) — so this cap
		// mainly bounds the NON-reranker path, which retrieves the deliberately-wider net but stays
		// ungrounded (relevanceVerified=false): without the cap it would dump ~26 sources into the context.
		// A no-op for the reranking-on paths (≤keep or []); the allowEmpty [] result stays [].
		merged = merged.slice(0, keep);
		const rerankMs = Date.now() - rerankStart;
		if (progress) progress.stage = "enrich";
		const enrichStart = Date.now();

		// Bounded Firecrawl enrichment — MUST run before `sources`/`evidence` are built below, since
		// those are derived from `merged` right after this: mutating `merged` any later would be a
		// silent no-op (the richer summary would never reach the model or the citation strip).
		// Gated on relevanceVerified: only spend extra scrape credits on sources already trusted as
		// relevant (with reranking off, relevanceVerified is always false and this never fires — the
		// same fail-closed posture as the rest of this function, not a bug).
		if (reranking && relevanceVerified) {
			// Engineering judgment, not a measured threshold — revisit if it misfires in practice.
			const FIRECRAWL_ENRICH_MIN_SNIPPET = 80; // chars; below this too thin to cite meaningfully
			const FIRECRAWL_ENRICH_SPARSE_THRESHOLD = 2; // kept-source count that counts as "sparse"
			const FIRECRAWL_ENRICH_MAX = 3; // hard cap on scrape calls per turn, regardless of trigger
			// Against the live API (markdown format, cold pages) a scrape takes 0.5-2.5s. 3000ms is
			// real headroom, not a guaranteed-timeout — still bounded so an outlier-slow scrape can't hang the turn.
			const FIRECRAWL_ENRICH_TIMEOUT_MS = 3000;
			const sparse = merged.length <= FIRECRAWL_ENRICH_SPARSE_THRESHOLD;
			const candidateIdx = merged
				.map((s, i) => i)
				.filter(
					(i) =>
						merged[i].engine === "Firecrawl" &&
						(sparse || merged[i].snippet.length < FIRECRAWL_ENRICH_MIN_SNIPPET)
				)
				.slice(0, FIRECRAWL_ENRICH_MAX);
			if (candidateIdx.length) {
				const enrichController = new AbortController();
				const enrichTimer = setTimeout(() => enrichController.abort(), FIRECRAWL_ENRICH_TIMEOUT_MS);
				const results = await Promise.allSettled(
					candidateIdx.map((i) => enrichFirecrawlSnippet(merged[i].url, enrichController.signal))
				);
				clearTimeout(enrichTimer);
				results.forEach((r, j) => {
					if (r.status === "fulfilled" && r.value) {
						const idx = candidateIdx[j];
						const { snippet, asOf } = r.value;
						merged[idx] = { ...merged[idx], snippet: snippet.slice(0, 900), ...(asOf ? { asOf } : {}) };
					}
				});
			}

			// There is no prompt-injection classifier on retrieved content: the one available could not
			// separate benign text from an attack (CUR-54). Retrieved content reaches the model only as
			// fenced, cited evidence (buildWebEvidence above), never as instructions.
		}

		if (progress) progress.stage = "done";
		const timings: WebTimings = {
			enginesMs,
			engineMs,
			...(cutEngines.length ? { cutEngines } : {}),
			rerankMs,
			enrichMs: Date.now() - enrichStart,
		};
		return {
			query: searchQuery,
			merged,
			asOf,
			relevanceVerified,
			timings,
			...(credibility ? { credibility } : {}),
		};
	} finally {
		clearTimeout(timer);
		clearTimeout(graceTimer);
	}
}

/** Open-web search with citation numbers assigned immediately. `startAt` offsets the numbers so web
 *  sources continue AFTER community/RAG sources already numbered for this turn (community-first: RAG is
 *  [1..k], web is [k+1..]); the evidence block is numbered with the same offset, so the model's `[n]`
 *  markers line up with the rendered source list. Defaults to 0 (web-only turn — /api/search, or the
 *  chat auto path where the community count is already known before search runs). */
export async function openSearch(
	query: string,
	opts: RetrieveWebOpts & { startAt?: number } = {}
): Promise<WebSearchOutcome> {
	const { startAt = 0, ...retrieveOpts } = opts;
	const r = await retrieveWeb(query, retrieveOpts);
	const { sources, evidence } = numberWebSources(r.merged, startAt, r.credibility);
	return { query: r.query, sources, evidence, asOf: r.asOf, relevanceVerified: r.relevanceVerified };
}
