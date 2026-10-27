import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { configValues, flagOn, ssrfStrictFetch } = vi.hoisted(() => ({
	configValues: {} as Record<string, string>,
	flagOn: { value: false },
	ssrfStrictFetch: vi.fn(),
}));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => flagOn.value }));
vi.mock("$lib/chat/server/urlSafety", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/urlSafety")>()),
	ssrfStrictFetch,
}));

import { fetchLinkedPage } from "./openSearch";

const para = (i: number) =>
	`<p>Paragraph ${i} of the linked article, long enough that Readability treats this block as the page's main text rather than chrome around it.</p>`;
const PAGE = `<html><head><title>A linked article</title></head><body><nav>Home News Sign in</nav><article>${Array.from({ length: 8 }, (_, i) => para(i + 1)).join("")}</article></body></html>`;
const htmlResponse = (html: string, status = 200) =>
	new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const firecrawl = vi.fn();
beforeEach(() => {
	flagOn.value = false;
	ssrfStrictFetch.mockReset();
	firecrawl.mockReset();
	vi.stubGlobal("fetch", firecrawl);
});
afterEach(() => {
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
});

// Firecrawl's onlyMainContent keeps GOV.UK's cookie banner, which X-ray would quote as the source.
// The removal happens at Firecrawl, so what this pins is the request: the scrape names GOV.UK's banner
// by its markup. The live effect is checked against Firecrawl on the ticket (CUR-4198).
describe("Firecrawl scrape request (CUR-4198)", () => {
	it("asks Firecrawl to drop cookie consent banners by markup, including GOV.UK's, so a source never opens on one", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		firecrawl.mockResolvedValue(
			Response.json({ data: { markdown: "A paragraph of Firecrawl markdown that is well over thirty characters.", metadata: { title: "T" } } })
		);
		await fetchLinkedPage("https://www.gov.uk/a");
		const body = JSON.parse(String((firecrawl.mock.calls[0][1] as RequestInit).body)) as { excludeTags?: string[] };
		expect(body.excludeTags).toContain("#global-cookie-message");
		// Markup, never wording: a selector on banner text would hold only in English.
		expect(body.excludeTags?.every((t) => /^[#.[]/.test(t))).toBe(true);
	});
});

describe("fetchLinkedPage direct read (CUR-2152)", () => {
	it("returns undefined without touching the network when there is no Firecrawl key and readable-extract is off", async () => {
		expect(await fetchLinkedPage("https://example.org/a")).toBeUndefined();
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
		expect(firecrawl).not.toHaveBeenCalled();
	});

	it("reads the page directly through the SSRF-strict fetch, as engine Direct, when there is no key and the flag is on", async () => {
		flagOn.value = true;
		ssrfStrictFetch.mockResolvedValue(htmlResponse(PAGE));
		const page = await fetchLinkedPage("https://example.org/a");
		expect(page?.engine).toBe("Direct");
		expect(page?.title).toBe("Linked page: A linked article");
		expect(page?.snippet).toContain("Paragraph 8 of the linked article");
		expect(page?.snippet).not.toContain("Sign in");
	});

	it("falls through to the direct read when Firecrawl answers but can't read the page", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		flagOn.value = true;
		firecrawl.mockResolvedValue(Response.json({ data: { markdown: "", metadata: { statusCode: 403 } } }));
		ssrfStrictFetch.mockResolvedValue(htmlResponse(PAGE));
		expect((await fetchLinkedPage("https://example.org/a"))?.engine).toBe("Direct");
	});

	it("keeps Firecrawl's page and never fetches directly when Firecrawl reads it", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		flagOn.value = true;
		firecrawl.mockResolvedValue(
			Response.json({ data: { markdown: "A paragraph of Firecrawl markdown that is well over thirty characters.", metadata: { title: "T" } } })
		);
		expect((await fetchLinkedPage("https://example.org/a"))?.engine).toBe("Firecrawl");
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
	});

	// The page's title arrives decoded from the extractor, and fetchLinkedPage adds no decode of
	// its own. Readability unescapes its title once more upstream, so a literal "&amp;lt;" on a page still
	// reads as "<" on this path; that pass is Readability's. (CUR-4068)
	it("gives the direct read's title as decoded text", async () => {
		flagOn.value = true;
		ssrfStrictFetch.mockResolvedValue(htmlResponse(PAGE.replace("A linked article", "Q&amp;A &#8211; part 2")));
		expect((await fetchLinkedPage("https://example.org/a"))?.title).toBe("Linked page: Q&A – part 2");
	});

	it("decodes entities left in Firecrawl's page title", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		firecrawl.mockResolvedValue(
			Response.json({ data: { markdown: "A paragraph of Firecrawl markdown that is well over thirty characters.", metadata: { title: "Q&amp;A &#8211; part 2" } } })
		);
		expect((await fetchLinkedPage("https://example.org/a"))?.title).toBe("Linked page: Q&A – part 2");
	});

	it("skips Firecrawl under the linked_page_firecrawl_down fault even with a key", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		flagOn.value = true;
		ssrfStrictFetch.mockResolvedValue(htmlResponse(PAGE));
		expect((await fetchLinkedPage("https://example.org/a", { skipFirecrawl: true }))?.engine).toBe("Direct");
		expect(firecrawl).not.toHaveBeenCalled();
	});

	it("refuses a plain-http link before any request, since the direct read runs on this deployment's network", async () => {
		flagOn.value = true;
		expect(await fetchLinkedPage("http://example.org/a")).toBeUndefined();
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
	});

	it("returns undefined for a non-HTML response rather than extracting it", async () => {
		flagOn.value = true;
		ssrfStrictFetch.mockResolvedValue(new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
		expect(await fetchLinkedPage("https://example.org/a.pdf")).toBeUndefined();
	});
});

describe("a linked page carries the date it states (CUR-4147)", () => {
	it("reads Firecrawl's metadata date into the page's asOf", async () => {
		configValues.FIRECRAWL_API_KEY = "k";
		firecrawl.mockResolvedValue(
			Response.json({
				data: {
					markdown: "A paragraph of Firecrawl markdown that is well over thirty characters.",
					metadata: { title: "T", "govuk:public-updated-at": "2025-05-28T11:56:10+01:00", cachedAt: new Date().toISOString() },
				},
			})
		);
		expect((await fetchLinkedPage("https://example.org/a"))?.asOf).toBe("2025-05-28");
	});

	it("reads the direct page's article:published_time, and leaves a page with none undated", async () => {
		flagOn.value = true;
		const dated = PAGE.replace("<title>", '<meta property="article:published_time" content="2024-06-03T08:00:00Z"><title>');
		ssrfStrictFetch.mockResolvedValue(htmlResponse(dated));
		expect((await fetchLinkedPage("https://example.org/a"))?.asOf).toBe("2024-06-03");
		ssrfStrictFetch.mockResolvedValue(htmlResponse(PAGE));
		expect((await fetchLinkedPage("https://example.org/a"))?.asOf).toBeUndefined();
	});
});
