import { describe, it, expect, vi, afterEach } from "vitest";

const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("./entityCorrection", () => ({ correctEntityQuery: vi.fn().mockResolvedValue(undefined) }));

import { openSearch } from "./openSearch";

const okJson = (x: unknown) => ({ ok: true, status: 200, json: async () => x, text: async () => "" });

const SEARXNG_PAGE = "https://example.org/searxng-only-page";
/** A fetch that answers SearXNG with one page and every other engine with nothing. */
function stubFetch() {
	return vi.fn(async (input: unknown) => {
		const u = String(input);
		if (u.startsWith("http://searxng:8080/search"))
			return okJson({
				results: [
					{ url: SEARXNG_PAGE, title: "SearXNG result", content: "A **bold** claim from the open web.", publishedDate: "2026-11-01T00:00:00" },
					{ url: SEARXNG_PAGE, title: "duplicate", content: "the same page from a second engine" },
				],
			}) as unknown as Response;
		return okJson({}) as unknown as Response;
	});
}

afterEach(() => {
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
});

describe("SearXNG as the general-web engine", () => {
	it("with SEARXNG_URL set and no FIRECRAWL_API_KEY, openSearch asks SearXNG's JSON API and cites its result as SearXNG", async () => {
		configValues.SEARXNG_URL = "http://searxng:8080/";
		const fetchMock = stubFetch();
		vi.stubGlobal("fetch", fetchMock);
		const res = await openSearch("self hosted metasearch", { perEngineTimeoutMs: 500 });
		const asked = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0]))).filter((u) => u.host === "searxng:8080");
		expect(asked).toHaveLength(1);
		expect(asked[0].pathname).toBe("/search");
		expect(asked[0].searchParams.get("format")).toBe("json");
		expect(asked[0].searchParams.get("q")).toContain("metasearch");
		const fromSearxng = res.sources.filter((s) => s.engine === "SearXNG");
		expect(fromSearxng.map((s) => s.url)).toEqual([SEARXNG_PAGE]);
		expect(fromSearxng[0].snippet).toBe("A bold claim from the open web.");
	});

	it("with FIRECRAWL_API_KEY set, openSearch never asks SearXNG even when SEARXNG_URL is set (Firecrawl keeps the slot)", async () => {
		configValues.SEARXNG_URL = "http://searxng:8080";
		configValues.FIRECRAWL_API_KEY = "test-key";
		const fetchMock = stubFetch();
		vi.stubGlobal("fetch", fetchMock);
		await openSearch("hosted search", { perEngineTimeoutMs: 500 });
		const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
		expect(urls).toContain("https://api.firecrawl.dev/v2/search");
		expect(urls.some((u) => u.includes("searxng"))).toBe(false);
	});

	it("with SEARXNG_URL unset, openSearch sends nothing to any SearXNG host (search behaves as before)", async () => {
		const fetchMock = stubFetch();
		vi.stubGlobal("fetch", fetchMock);
		await openSearch("plain search", { perEngineTimeoutMs: 500 });
		const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
		expect(urls.some((u) => u.includes("searxng") || u.includes("/search?"))).toBe(false);
	});
});
