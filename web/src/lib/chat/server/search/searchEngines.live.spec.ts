import { describe, it, expect } from "vitest";
import { fetchRetryOnce } from "$lib/chat/server/fetchRetryOnce";

// LIVE CONTRACT CHECKS for the web-search engines.
//
// These all fail OPEN: a broken engine returns nothing, search degrades, and the turn still answers —
// just less grounded. So this is not an availability check like Coop's. It is the only thing that can notice
// grounding quietly getting worse, because "fails open" and "silently returns zero results" look
// identical from every monitor we have.
//
// THREE OF THE FOUR NEED NO CREDENTIALS (OpenAlex, arXiv, HuggingFace are public), so they are gated
// only on SEARCH_LIVE=1 and cost nothing but a nightly HTTP call. Firecrawl needs a key and skips
// without one.
//
// Assertions mirror openSearch.ts exactly — the fields it READS, not everything the vendor returns.
// Extra fields are fine; a field we parse disappearing is not.
//
// THE arXiv CASE IS THE REASON THIS FILE EXISTS. Its response is XML parsed by REGEX
// (`xml.match(/<entry>[\\s\\S]*?<\\/entry>/g)`), so a namespaced tag, a self-closing element, or a
// formatting change yields ZERO entries — not an error. Search then silently loses a whole engine and
// nothing anywhere goes red. That is a fail-open inside a fail-open.

const LIVE = process.env.SEARCH_LIVE === "1";
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || "";
const TIMEOUT = 30_000;
const QUERY = "open source language model";

describe.skipIf(!LIVE)("web-search engine contracts (live)", () => {
	it("OpenAlex still returns results[] with the fields we map", async () => {
		const u = new URL("https://api.openalex.org/works");
		u.searchParams.set("search", QUERY);
		u.searchParams.set("per-page", "5");
		u.searchParams.set("mailto", "contact@aipotluck.org"); // polite pool, same as openSearch.ts
		// OpenAlex answers 429 or 503 intermittently, which fails the night with
		// the contract intact. Same one retry arXiv gets below. (CUR-2759)
		const res = await fetchRetryOnce(() => fetch(u, { signal: AbortSignal.timeout(TIMEOUT) }), {
			retryableStatuses: [429, 503],
			delayMs: 5_000,
		});
		expect(res.status).toBe(200);
		const data = await res.json();

		expect(Array.isArray(data?.results), "results[] is what openSearch maps over").toBe(true);
		expect(data.results.length).toBeGreaterThan(0);

		// openSearch FILTERS on a non-empty title, so a title rename would silently drop every hit.
		const titled = data.results.filter((w: { title?: string }) => w.title?.trim());
		expect(titled.length, "every result filtered out — `title` moved or emptied").toBeGreaterThan(0);

		// The url falls back doi → primary_location.landing_page_url → open_access.oa_url → id.
		// If ALL four vanish the result is unlinkable.
		for (const w of titled.slice(0, 3)) {
			const url = w.doi || w.primary_location?.landing_page_url || w.open_access?.oa_url || w.id;
			expect(typeof url, "no usable URL field on an OpenAlex work").toBe("string");
		}
	}, 60_000);

	// The regex-on-XML one. Asserts the PARSE, not just the HTTP call, because a 200 with unmatched
	// markup is exactly the silent-zero failure.
	it("arXiv XML still yields <entry> blocks our regex can read", async () => {
		const u = new URL("https://export.arxiv.org/api/query");
		u.searchParams.set("search_query", `all:${QUERY}`);
		u.searchParams.set("sortBy", "relevance");
		u.searchParams.set("max_results", "5");
		// A 429 here is arXiv's rate limit, not a broken contract — this suite's own three
		// other tests hit public/free APIs too, and a shared IP running them back-to-back nightly can
		// trip one. Retried once with a real gap before this hard-fails. (CUR-1303)
		const res = await fetchRetryOnce(() => fetch(u, { signal: AbortSignal.timeout(TIMEOUT) }), {
			retryableStatuses: [429],
			delayMs: 5_000,
		});
		expect(res.status).toBe(200);
		const xml = await res.text();

		// Byte-identical to openSearch.ts. If this stops matching, the engine returns zero results and
		// nothing else in the system notices.
		const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
		expect(
			entries.length,
			"arXiv returned 200 but our <entry> regex matched NOTHING — namespaced or self-closing tags would do this, and search would silently lose the engine"
		).toBeGreaterThan(0);

		const pick = (block: string, tag: string): string => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
			return m ? m[1].replace(/\s+/g, " ").trim() : "";
		};
		const first = entries[0]!;
		expect(pick(first, "title").length, "<title> unreadable").toBeGreaterThan(0);
		expect(pick(first, "summary").length, "<summary> unreadable — snippets would be empty").toBeGreaterThan(0);
		expect(first.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim(), "<id> is the canonical URL").toBeTruthy();
	}, 60_000);

	// The query differs here: HF's /api/models `search` is a SUBSTRING match over
	// model ids, not a natural-language search — "open source language model" returns 0 results while
	// "llama" returns 5. That is a relevance property of the engine, not a contract break, so this test
	// uses a term-shaped query to check the SHAPE. Whether we should be sending prose to this engine at
	// all is a separate question (CUR-71).
	it("HuggingFace /api/models still returns a bare array with id", async () => {
		const u = new URL("https://huggingface.co/api/models");
		u.searchParams.set("search", "llama");
		u.searchParams.set("sort", "downloads");
		u.searchParams.set("direction", "-1");
		u.searchParams.set("limit", "5");
		const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) });
		expect(res.status).toBe(200);
		const data = await res.json();

		// openSearch does `Array.isArray(data) ? data : []` — a wrapped object would yield zero results
		// with no error at all.
		expect(Array.isArray(data), "a wrapped response silently yields ZERO results").toBe(true);
		expect(data.length).toBeGreaterThan(0);
		// `id` is both the filter key and the title/url, so losing it drops every hit.
		expect(typeof data[0]?.id, "`id` is the filter key, title AND url").toBe("string");
	}, 60_000);

	it.skipIf(!FIRECRAWL_KEY)("Firecrawl /v2/search still returns the documented envelope", async () => {
		const res = await fetch("https://api.firecrawl.dev/v2/search", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${FIRECRAWL_KEY}` },
			body: JSON.stringify({ query: QUERY, limit: 3 }),
			signal: AbortSignal.timeout(TIMEOUT),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data?.success, "Firecrawl signals failure in-band via success:false").not.toBe(false);
		const web = data?.data?.web ?? data?.data;
		expect(Array.isArray(web), "results moved out of data.web").toBe(true);
	}, 60_000);
});
