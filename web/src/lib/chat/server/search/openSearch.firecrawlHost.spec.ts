import { describe, it, expect, vi, afterEach } from "vitest";

const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("./entityCorrection", () => ({ correctEntityQuery: vi.fn().mockResolvedValue(undefined) }));

import { openSearch } from "./openSearch";

const okJson = (x: unknown) => ({ ok: true, status: 200, json: async () => x, text: async () => "" });

afterEach(() => {
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
});

describe("Firecrawl host", () => {
	it("openSearch sends its Firecrawl search request to FIRECRAWL_BASE_URL, never api.firecrawl.dev, when it is set (trailing slash stripped)", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		configValues.FIRECRAWL_BASE_URL = "http://firecrawl:3002/";
		const fetchMock = vi.fn(async () => okJson({ data: { web: [] } }) as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);
		await openSearch("self hosted search", { perEngineTimeoutMs: 500 });
		const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
		expect(urls).toContain("http://firecrawl:3002/v2/search");
		expect(urls.some((u) => u.includes("api.firecrawl.dev"))).toBe(false);
	});

	it("openSearch sends its Firecrawl search request to api.firecrawl.dev when FIRECRAWL_BASE_URL is unset", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		const fetchMock = vi.fn(async () => okJson({ data: { web: [] } }) as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);
		await openSearch("hosted search", { perEngineTimeoutMs: 500 });
		const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
		expect(urls).toContain("https://api.firecrawl.dev/v2/search");
	});
});
